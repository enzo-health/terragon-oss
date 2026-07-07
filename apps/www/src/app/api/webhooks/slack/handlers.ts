import { WebClient } from "@slack/web-api";
import { db } from "@/lib/db";
import {
  claimSlackTaskDelivery,
  completeSlackTaskDelivery,
  markSlackTaskDeliveryOmitted,
  markSlackTaskDeliveryFailed,
} from "@terragon/shared/model/slack";
import { SlackAccount } from "@terragon/shared";
import { publicAppUrl } from "@terragon/env/next-public";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { formatThreadContext } from "@/server-lib/ext-thread-context";
import {
  convertSlackFilesToMessageParts,
  formatSlackFileConversionNote,
  SlackFileConversionResult,
} from "@/server-lib/slack/slack-files";
import {
  completeExistingSlackMentionTaskIfPresent,
  ensureSlackThreadLinkForMention,
  resolveSlackMentionContext,
  resolveSlackMentionDefaultModel,
} from "@/server-lib/slack/slack-mention-task";
import type { SlackAppMentionEvent } from "@/server-lib/slack/slack-events";

export type {
  SlackAppMentionEvent,
  SlackInteractiveAction,
} from "@/server-lib/slack/slack-events";

/**
 * Replaces user mentions like <@U123456> and bot mentions like <@B123456> with readable names
 */
function cleanSlackText({
  text,
  atMentionNameMap,
}: {
  text: string;
  atMentionNameMap: Map<string, string>;
}): string {
  // Replace user and bot mentions with actual names
  return text.replace(/<@([UBW][A-Z0-9]+)>/g, (match, id) => {
    const name = atMentionNameMap.get(id);
    if (name) {
      return `@${name}`;
    }
    // fallback
    return `@${id}`;
  });
}

function stripSlackMentions(text: string) {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

function normalizeName(name: string): string {
  if (name.includes(" ")) {
    return JSON.stringify(name);
  }
  return name;
}

async function getAtMentionNameMap({
  slack,
  event,
  messageTexts,
  messageBotIds,
  messageAuthorIds,
}: {
  slack: WebClient;
  event: SlackAppMentionEvent;
  messageBotIds: string[];
  messageAuthorIds: string[];
  messageTexts: string[];
}): Promise<Map<string, string>> {
  const atMentionNameMap = new Map<string, string>();
  const userIds = new Set<string>(messageAuthorIds);
  const botIds = new Set<string>(messageBotIds);
  for (const messageText of messageTexts) {
    const mentionMatches = messageText.matchAll(/<@([UBW][A-Z0-9]+)>/g);
    for (const match of mentionMatches) {
      if (match[1]) {
        if (match[1].startsWith("U") || match[1].startsWith("W")) {
          userIds.add(match[1]);
        } else if (match[1].startsWith("B")) {
          botIds.add(match[1]);
        }
      }
    }
  }
  await Promise.all([
    ...Array.from(userIds).map(async (userId) => {
      try {
        const userInfo = await slack.users.info({ user: userId });
        if (userInfo.user) {
          atMentionNameMap.set(
            userId,
            normalizeName(
              userInfo.user.profile?.display_name ||
                userInfo.user.profile?.real_name ||
                userInfo.user.name ||
                userInfo.user.real_name ||
                userId,
            ),
          );
        }
      } catch (error) {
        console.warn("[slack webhook] Failed to fetch Slack user info", {
          userId,
          error,
        });
      }
    }),
    ...Array.from(botIds).map(async (botId) => {
      try {
        const botInfo = await slack.bots.info({ bot: botId });
        if (botInfo.bot) {
          atMentionNameMap.set(botId, normalizeName(botInfo.bot.name || botId));
        }
      } catch (error) {
        console.warn("[slack webhook] Failed to fetch Slack bot info", {
          botId,
          error,
        });
      }
    }),
  ]);
  return atMentionNameMap;
}

/**
 * Generate a Slack permalink for a message
 * @param workspaceDomain - The Slack workspace domain
 * @param channel - The channel ID
 * @param messageTs - The timestamp of the specific message
 * @param threadTs - The parent thread timestamp (if in a thread)
 * @returns The Slack permalink URL or null if workspace domain is not available
 */
function getSlackMessagePermalink({
  workspaceDomain,
  channel,
  messageTs,
  threadTs,
}: {
  workspaceDomain: string | null;
  channel: string;
  messageTs: string | null | undefined;
  threadTs?: string;
}): string | null {
  if (!workspaceDomain || !messageTs) {
    return null;
  }

  const formattedTs = messageTs.replace(".", "");
  const baseUrl = `https://${workspaceDomain}.slack.com/archives/${channel}/p${formattedTs}`;

  // If it's a threaded message, add query parameters
  if (threadTs && threadTs !== messageTs) {
    return `${baseUrl}?thread_ts=${threadTs}&cid=${channel}`;
  }

  return baseUrl;
}

/**
 * Builds a formatted message for a Slack mention task
 * @param slack - Slack Web Client instance
 * @param event - The Slack app mention event
 * @param workspaceDomain - The Slack workspace domain for generating permalink
 * @returns Formatted message string
 */
export async function buildSlackMentionMessage({
  slackAccount,
  slack,
  event,
  fileConversion,
}: {
  slackAccount: SlackAccount;
  slack: WebClient;
  event: SlackAppMentionEvent;
  fileConversion?: SlackFileConversionResult;
}): Promise<string> {
  const threadTs = event.thread_ts || event.ts;

  // Fetch thread replies and channel name in parallel
  const [threadReplies, channelName] = await Promise.all([
    getThreadReplies({ slack, event }),
    getChannelName({ slack, event }),
  ]);

  // Build at-mention name map
  const messageAuthorIds = [event.user];
  const messageBotIds = [];
  const messageTexts = [event.text];
  for (const reply of threadReplies) {
    if (reply.type === "user") {
      messageAuthorIds.push(reply.id);
    } else if (reply.type === "bot") {
      messageBotIds.push(reply.id);
    }
    messageTexts.push(reply.text);
  }
  const atMentionNameMap = await getAtMentionNameMap({
    slack,
    event,
    messageAuthorIds,
    messageBotIds,
    messageTexts,
  });
  const [threadContext, cleanedMessageTextRaw] = await Promise.all([
    getThreadContext({
      slack,
      replies: threadReplies,
      atMentionNameMap,
    }),
    cleanSlackText({
      text: event.text,
      atMentionNameMap,
    }),
  ]);
  const cleanedMessageText = stripSlackMentions(event.text)
    ? cleanedMessageTextRaw
    : "Attached Slack file(s).";

  // Create Slack thread link to the specific message
  const slackThreadLink = getSlackMessagePermalink({
    workspaceDomain: slackAccount.slackTeamDomain,
    channel: event.channel,
    messageTs: event.ts,
    threadTs,
  });

  // Build the message parts
  const mentioningUserName = atMentionNameMap.get(event.user) || event.user;
  const messageParts = [
    `@${mentioningUserName} mentioned you in ${channelName} with the following message:`,
    cleanedMessageText,
  ];
  // Add thread context if available
  if (threadContext) {
    messageParts.push(`Here's the context of the thread:\n${threadContext}`);
  }
  if (fileConversion) {
    const attachmentNote = formatSlackFileConversionNote({
      ...fileConversion,
      attachedCount: fileConversion.parts.length,
    });
    if (attachmentNote) {
      messageParts.push(attachmentNote);
    }
  }
  messageParts.push(
    "Please work on this task. Your work will be sent to the user once you're done.",
  );
  if (slackThreadLink) {
    messageParts.push(slackThreadLink);
  }

  return messageParts.join("\n\n");
}

type ThreadReply =
  | { type: "user"; id: string; text: string }
  | { type: "bot"; id: string; text: string };

async function getThreadReplies({
  slack,
  event,
}: {
  slack: WebClient;
  event: SlackAppMentionEvent;
}): Promise<ThreadReply[]> {
  if (!event.thread_ts || event.thread_ts === event.ts) {
    return [];
  }
  let threadMessages;
  try {
    threadMessages = await slack.conversations.replies({
      channel: event.channel,
      ts: event.thread_ts || event.ts,
      limit: 100, // Get up to 100 messages in the thread
    });
  } catch (error) {
    console.warn("[slack webhook] Failed to fetch thread replies", error);
    return [];
  }
  return (
    threadMessages.messages
      ?.filter((msg) => {
        if (!msg.ts) {
          return false;
        }
        // Include messages that came before OR are the current mention
        return parseFloat(msg.ts || "0") <= parseFloat(event.ts || "0");
      })
      .map((msg) => {
        if (msg.user && msg.text) {
          return { type: "user" as const, id: msg.user, text: msg.text };
        }
        if (msg.bot_id && msg.text) {
          return { type: "bot" as const, id: msg.bot_id, text: msg.text };
        }
        return undefined;
      })
      .filter((msg) => msg !== undefined) || []
  );
}

async function getChannelName({
  slack,
  event,
}: {
  slack: WebClient;
  event: SlackAppMentionEvent;
}): Promise<string> {
  try {
    const channelInfo = await slack.conversations.info({
      channel: event.channel,
    });
    return channelInfo.channel?.name || event.channel;
  } catch (error) {
    console.warn(
      `[slack webhook] Failed to fetch channel info for ${event.channel}`,
      error,
    );
    return event.channel;
  }
}

async function getThreadContext({
  slack,
  replies,
  atMentionNameMap,
}: {
  slack: WebClient;
  replies: ThreadReply[];
  atMentionNameMap: Map<string, string>;
}): Promise<string> {
  if (replies.length === 0) {
    return "";
  }
  const entries = replies.map((reply) => {
    const userName = atMentionNameMap.get(reply.id) || reply.id;
    const cleanedText = cleanSlackText({
      text: reply.text,
      atMentionNameMap,
    });
    return {
      author: userName,
      body: cleanedText,
    };
  });

  return formatThreadContext(entries);
}

export async function handleAppMentionEvent(
  event: SlackAppMentionEvent,
): Promise<void> {
  console.log("[slack webhook] Received app mention", {
    team: event.team,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    slackEventId: event.slackEventId,
    fileCount: Array.isArray(event.files) ? event.files.length : 0,
  });
  // Skip processing if this is an edited message
  if (event.edited) {
    console.log("[slack webhook] Skipping edited message");
    return;
  }
  let slack: WebClient | null = null;
  let threadTs: string | null = null;
  let createdThreadId: string | null = null;
  let claimedDelivery: {
    deliveryKey: string;
    claimantToken: string;
    teamId: string;
    channel: string;
    messageTs: string;
  } | null = null;
  let createdThread: {
    threadId: string;
    threadChatId: string | null;
  } | null = null;
  try {
    const context = await resolveSlackMentionContext({ event });
    if (!context) {
      return;
    }
    slack = context.slack;
    threadTs = context.threadTs;

    if (await completeExistingSlackMentionTaskIfPresent({ event, context })) {
      return;
    }

    const claimResult = await claimSlackTaskDelivery({
      db,
      teamId: context.teamId,
      channel: event.channel,
      messageTs: event.ts,
      slackEventId: event.slackEventId,
    });
    if (!claimResult.claimed) {
      console.log("[slack webhook] Duplicate Slack mention delivery skipped", {
        teamId: context.teamId,
        channel: event.channel,
        messageTs: event.ts,
      });
      return;
    }
    claimedDelivery = {
      deliveryKey: claimResult.deliveryKey,
      claimantToken: claimResult.claimantToken!,
      teamId: context.teamId,
      channel: event.channel,
      messageTs: event.ts,
    };
    const hasFiles = Array.isArray(event.files) && event.files.length > 0;
    let fileConversion: SlackFileConversionResult = { parts: [], skipped: [] };
    if (context.slackAttachmentsEnabled && hasFiles) {
      try {
        fileConversion = await convertSlackFilesToMessageParts({
          files: event.files,
          botToken: context.slackBotToken,
          userId: context.slackAccount.userId,
        });
      } catch (error) {
        console.error("[slack webhook] Failed to import Slack attachment", {
          teamId: context.teamId,
          channel: event.channel,
          messageTs: event.ts,
          error,
        });
        await markSlackTaskDeliveryFailed({
          db,
          deliveryKey: claimResult.deliveryKey,
          claimantToken: claimResult.claimantToken,
          lastError: "slack-attachment-import-failed",
        });
        await slack.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: `I couldn't import the Slack attachment for this task. Please try again in a moment, or resend the message without the file.`,
        });
        return;
      }
    }
    const textWithoutMentions = stripSlackMentions(event.text);
    if (hasFiles && !textWithoutMentions && fileConversion.parts.length === 0) {
      await markSlackTaskDeliveryOmitted({
        db,
        deliveryKey: claimResult.deliveryKey,
        claimantToken: claimResult.claimantToken,
        omittedReason: context.slackAttachmentsEnabled
          ? "unsupported-attachments-empty-mention"
          : "attachments-disabled-empty-mention",
      });
      await slack.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: context.slackAttachmentsEnabled
          ? `I can't start a task from attachments alone yet. Please add a short text description with the file.`
          : `I can't start a task from attachments alone yet. Please add a short text description, or try again after Slack attachments are enabled for your workspace.`,
      });
      return;
    }

    const [defaultModel, formattedMessage] = await Promise.all([
      resolveSlackMentionDefaultModel({
        slackAccount: context.slackAccount,
        slackSettings: context.slackSettings,
      }),
      buildSlackMentionMessage({
        slackAccount: context.slackAccount,
        slack,
        event,
        fileConversion,
      }),
    ]);
    console.log(
      "[slack webhook] Creating thread for user",
      context.slackAccount.userId,
    );

    const { threadId, threadChatId } = await newThreadInternal({
      userId: context.slackAccount.userId,
      message: {
        type: "user",
        model: defaultModel,
        parts: [
          {
            type: "text",
            text: formattedMessage,
          },
          ...fileConversion.parts,
        ],
        timestamp: new Date().toISOString(),
      },
      parentThreadId: undefined,
      parentToolId: undefined,
      githubRepoFullName: context.slackSettings.defaultRepoFullName,
      baseBranchName: null,
      headBranchName: null,
      sourceType: "slack-mention",
      sourceMetadata: {
        type: "slack-mention",
        teamId: context.teamId,
        slackEventId: event.slackEventId,
        workspaceDomain: context.slackAccount.slackTeamDomain,
        channel: event.channel,
        messageTs: event.ts,
        threadTs,
      },
    });
    createdThreadId = threadId;
    createdThread = { threadId, threadChatId };
    const slackThreadLink = context.slackLiveSessionsEnabled
      ? await ensureSlackThreadLinkForMention({
          slackAccount: context.slackAccount,
          slackInstallation: context.slackInstallation,
          event,
          threadId,
          threadChatId,
        })
      : null;
    await completeSlackTaskDelivery({
      db,
      teamId: context.teamId,
      channel: event.channel,
      messageTs: event.ts,
      threadId,
      threadChatId,
      slackThreadLinkId: slackThreadLink?.id,
      claimantToken: claimResult.claimantToken,
    });
    // Send an acknowledgment
    await slack.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: `✅ Task created in ${context.slackSettings.defaultRepoFullName}: ${publicAppUrl()}/task/${threadId}`,
    });
    console.log("[slack webhook] Successfully created thread", threadId);
  } catch (error) {
    console.error("[slack webhook] Error handling app mention:", error);
    if (claimedDelivery) {
      if (createdThread) {
        await completeSlackTaskDelivery({
          db,
          teamId: claimedDelivery.teamId,
          channel: claimedDelivery.channel,
          messageTs: claimedDelivery.messageTs,
          deliveryKey: claimedDelivery.deliveryKey,
          threadId: createdThread.threadId,
          threadChatId: createdThread.threadChatId,
          claimantToken: claimedDelivery.claimantToken,
        }).catch((completeError) => {
          console.error(
            "[slack webhook] Failed to complete claimed Slack task delivery after error:",
            completeError,
          );
        });
      } else {
        await markSlackTaskDeliveryFailed({
          db,
          deliveryKey: claimedDelivery.deliveryKey,
          claimantToken: claimedDelivery.claimantToken,
          lastError:
            error instanceof Error ? error.message : "slack-task-create-failed",
        }).catch((markError) => {
          console.error(
            "[slack webhook] Failed to mark Slack task delivery failed:",
            markError,
          );
        });
      }
    }
    if (slack && threadTs && !createdThreadId) {
      await slack.chat
        .postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: `Sorry <@${event.user}>, I couldn't create a Terragon task from this message. Please try again in a moment or check your Slack integration settings.`,
        })
        .catch((postError) => {
          console.error(
            "[slack webhook] Failed to send Slack task creation failure message:",
            postError,
          );
        });
    }
  }
}
