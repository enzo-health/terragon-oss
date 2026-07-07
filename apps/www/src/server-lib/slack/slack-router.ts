import { WebClient } from "@slack/web-api";
import { env } from "@terragon/env/apps-www";
import { publicAppUrl } from "@terragon/env/next-public";
import { SlackThreadLink } from "@terragon/shared";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import {
  archiveSlackThreadLink,
  claimSlackTaskDelivery,
  completeSlackTaskDelivery,
  getActiveSlackThreadLink,
  getSlackAccountForSlackUserId,
  getSlackInstallationForTeam,
  markSlackTaskDeliveryFailed,
  markSlackTaskDeliveryIgnored,
  markSlackTaskDeliveryOmitted,
  markSlackThreadLinkInbound,
  setSlackThreadLinkMuteState,
  setSlackThreadLinkSleepState,
  wakeSlackThreadLink,
} from "@terragon/shared/model/slack";
import { decryptValue } from "@terragon/utils/encryption";
import { archiveAndStopThread } from "@/server-lib/archive-thread";
import { db } from "@/lib/db";
import { followUpInternal } from "@/server-lib/follow-up";
import { stopThread } from "@/server-lib/stop-thread";
import {
  convertSlackFilesToMessageParts,
  formatSlackFileConversionNote,
  SlackFileConversionResult,
} from "./slack-files";
import {
  isWakeAllowedWhileSleeping,
  parseSlackSessionCommand,
  SlackSessionCommand,
} from "./slack-command-parser";

export interface SlackMessageEvent {
  type: string;
  user?: string;
  text?: string;
  ts?: string;
  channel?: string;
  thread_ts?: string;
  team?: string;
  bot_id?: string;
  subtype?: string;
  hidden?: boolean;
  files?: unknown[];
  edited?: unknown;
}

function isIgnoredMessageEvent(event: SlackMessageEvent) {
  if (event.bot_id || event.hidden || event.edited) {
    return true;
  }
  return (
    event.subtype === "message_changed" ||
    event.subtype === "message_deleted" ||
    event.subtype === "bot_message" ||
    event.subtype === "channel_join" ||
    event.subtype === "channel_leave"
  );
}

function isSleeping(link: SlackThreadLink, now = new Date()) {
  if (link.sleepUntil && link.sleepUntil > now) {
    return true;
  }
  return !!link.sleepingAt && !link.sleepUntil;
}

function commandLabel(command: SlackSessionCommand) {
  return command.type === "resume" ? "wake" : command.type;
}

async function postThreadMessage({
  slack,
  link,
  text,
}: {
  slack: WebClient;
  link: SlackThreadLink;
  text: string;
}) {
  await slack.chat.postMessage({
    channel: link.channel,
    thread_ts: link.threadTs,
    text,
  });
}

async function handleCommand({
  command,
  link,
  slack,
}: {
  command: SlackSessionCommand;
  link: SlackThreadLink;
  slack: WebClient;
}) {
  switch (command.type) {
    case "archive":
      await archiveAndStopThread({
        userId: link.userId,
        threadId: link.threadId,
      });
      await archiveSlackThreadLink({ db, linkId: link.id });
      await postThreadMessage({
        slack,
        link,
        text: "Archived this Terragon task.",
      });
      return;
    case "aside":
      await postThreadMessage({
        slack,
        link,
        text: "Noted as an aside. I did not forward that to the agent.",
      });
      return;
    case "help":
      await postThreadMessage({
        slack,
        link,
        text: "Terragon Slack controls: reply normally to add a follow-up. Use `status`, `mute`, `unmute`, `sleep`, `sleep 1h`, `wake`, `archive`, or `stop`.",
      });
      return;
    case "mute":
      await setSlackThreadLinkMuteState({ db, linkId: link.id, muted: true });
      await postThreadMessage({
        slack,
        link,
        text: "Muted Slack updates for this Terragon task. Replies still go to Terragon.",
      });
      return;
    case "resume":
    case "wake":
      await wakeSlackThreadLink({ db, linkId: link.id });
      await postThreadMessage({
        slack,
        link,
        text: "Resumed Slack handling for this task.",
      });
      return;
    case "sleep":
      await setSlackThreadLinkSleepState({
        db,
        linkId: link.id,
        sleepUntil: command.until,
      });
      await postThreadMessage({
        slack,
        link,
        text: command.until
          ? `Sleeping this Slack thread until ${command.until.toLocaleString()}. Use \`wake\` to resume sooner.`
          : "Sleeping this Slack thread. Use `wake` to resume.",
      });
      return;
    case "status":
      await postThreadMessage({
        slack,
        link,
        text: `Terragon task: ${publicAppUrl()}/task/${link.threadId}`,
      });
      return;
    case "stop":
      if (!link.threadChatId) {
        await postThreadMessage({
          slack,
          link,
          text: "I could not stop this task from Slack because the linked chat is missing. Open the task in Terragon to stop it.",
        });
        return;
      }
      await stopThread({
        userId: link.userId,
        threadId: link.threadId,
        threadChatId: link.threadChatId,
      });
      await postThreadMessage({
        slack,
        link,
        text: "Stopping this Terragon task.",
      });
      return;
    case "unmute":
      await setSlackThreadLinkMuteState({ db, linkId: link.id, muted: false });
      await postThreadMessage({
        slack,
        link,
        text: "Unmuted Slack updates for this task.",
      });
      return;
  }
}

export async function handleSlackMessageEvent({
  event,
  slackEventId,
}: {
  event: SlackMessageEvent;
  slackEventId?: string;
}) {
  const teamId = event.team;
  const channel = event.channel;
  const messageTs = event.ts;
  const actorSlackUserId = event.user;
  if (!teamId || !channel || !messageTs || !actorSlackUserId) {
    return;
  }
  if (isIgnoredMessageEvent(event)) {
    return;
  }

  const threadTs = event.thread_ts || messageTs;
  const link = await getActiveSlackThreadLink({
    db,
    teamId,
    channel,
    threadTs,
  });
  if (!link) {
    return;
  }

  const installation = await getSlackInstallationForTeam({ db, teamId });
  if (!installation) {
    return;
  }
  const slackBotToken = decryptValue(
    installation.botAccessTokenEncrypted,
    env.ENCRYPTION_MASTER_KEY,
  );
  const slack = new WebClient(slackBotToken);

  const command = parseSlackSessionCommand(event.text ?? "");
  const sleeping = isSleeping(link);
  if (sleeping && !isWakeAllowedWhileSleeping(command)) {
    const claim = await claimSlackTaskDelivery({
      db,
      teamId,
      channel,
      messageTs,
      slackEventId,
      action: "follow-up",
    });
    if (claim.claimed) {
      await markSlackTaskDeliveryIgnored({
        db,
        deliveryKey: claim.deliveryKey,
        claimantToken: claim.claimantToken,
        ignoredReason: "slack-link-sleeping",
      });
    }
    return;
  }

  const commandEnabled = await getFeatureFlagForUser({
    db,
    userId: link.userId,
    flagName: "slackCommandsEnabled",
  });
  if (command && commandEnabled) {
    const claim = await claimSlackTaskDelivery({
      db,
      teamId,
      channel,
      messageTs,
      slackEventId,
      action: "command",
      actionId: commandLabel(command),
      actorSlackUserId,
      actionTs: messageTs,
    });
    if (!claim.claimed) {
      return;
    }
    await handleCommand({ command, link, slack });
    await completeSlackTaskDelivery({
      db,
      teamId,
      channel,
      messageTs,
      deliveryKey: claim.deliveryKey,
      threadId: link.threadId,
      threadChatId: link.threadChatId,
      slackThreadLinkId: link.id,
      claimantToken: claim.claimantToken,
    });
    return;
  }

  const [repliesEnabled, slackAttachmentsEnabled] = await Promise.all([
    getFeatureFlagForUser({
      db,
      userId: link.userId,
      flagName: "slackThreadRepliesToFollowUps",
    }),
    getFeatureFlagForUser({
      db,
      userId: link.userId,
      flagName: "slackAttachmentsEnabled",
    }),
  ]);
  if (!repliesEnabled) {
    return;
  }

  const actorAccount = await getSlackAccountForSlackUserId({
    db,
    teamId,
    slackUserId: actorSlackUserId,
  });
  if (
    !actorAccount ||
    (link.collaborationMode === "owner-only" &&
      actorAccount.userId !== link.userId)
  ) {
    await postThreadMessage({
      slack,
      link,
      text: `I can't add this reply to Terragon until <@${actorSlackUserId}> connects their Slack account for this workspace.`,
    });
    return;
  }

  const claim = await claimSlackTaskDelivery({
    db,
    teamId,
    channel,
    messageTs,
    slackEventId,
    action: "follow-up",
  });
  if (!claim.claimed) {
    return;
  }

  const hasFiles = Array.isArray(event.files) && event.files.length > 0;
  const text = (event.text ?? "").trim();
  let fileConversion: SlackFileConversionResult = { parts: [], skipped: [] };
  if (slackAttachmentsEnabled && hasFiles) {
    try {
      fileConversion = await convertSlackFilesToMessageParts({
        files: event.files,
        botToken: slackBotToken,
        userId: link.userId,
      });
    } catch (error) {
      console.error("[slack webhook] Failed to import Slack reply attachment", {
        teamId,
        channel,
        messageTs,
        error,
      });
      await markSlackTaskDeliveryFailed({
        db,
        deliveryKey: claim.deliveryKey,
        claimantToken: claim.claimantToken,
        lastError: "slack-attachment-import-failed",
      });
      await postThreadMessage({
        slack,
        link,
        text: "I could not import that Slack attachment into Terragon. Please try again in a moment, or resend the reply without the file.",
      });
      return;
    }
  }
  if (hasFiles && !text && fileConversion.parts.length === 0) {
    await markSlackTaskDeliveryOmitted({
      db,
      deliveryKey: claim.deliveryKey,
      claimantToken: claim.claimantToken,
      omittedReason: slackAttachmentsEnabled
        ? "unsupported-attachments-empty-reply"
        : "attachments-disabled-empty-reply",
    });
    await postThreadMessage({
      slack,
      link,
      text: slackAttachmentsEnabled
        ? "I could not add that attachment-only reply because none of the files were supported or available."
        : "I could not add that attachment-only reply yet. Please add a short text reply, or try again after Slack attachments are enabled.",
    });
    return;
  }
  if (!text && fileConversion.parts.length === 0) {
    await markSlackTaskDeliveryIgnored({
      db,
      deliveryKey: claim.deliveryKey,
      claimantToken: claim.claimantToken,
      ignoredReason: "empty-message",
    });
    return;
  }
  if (!link.threadChatId) {
    await markSlackTaskDeliveryOmitted({
      db,
      deliveryKey: claim.deliveryKey,
      claimantToken: claim.claimantToken,
      omittedReason: "missing-thread-chat-id",
    });
    return;
  }

  const attachmentNote = formatSlackFileConversionNote({
    ...fileConversion,
    attachedCount: fileConversion.parts.length,
  });
  const messageText = [
    `Slack reply from <@${actorSlackUserId}>:`,
    text || "Attached Slack file(s).",
    attachmentNote,
  ]
    .filter(Boolean)
    .join("\n\n");

  await followUpInternal({
    userId: link.userId,
    threadId: link.threadId,
    threadChatId: link.threadChatId,
    source: "slack",
    message: {
      type: "user",
      model: null,
      parts: [
        {
          type: "text",
          text: messageText,
        },
        ...fileConversion.parts,
      ],
      timestamp: new Date().toISOString(),
    },
  });
  await markSlackThreadLinkInbound({
    db,
    linkId: link.id,
    messageTs,
    actorSlackUserId,
  });
  await completeSlackTaskDelivery({
    db,
    teamId,
    channel,
    messageTs,
    deliveryKey: claim.deliveryKey,
    threadId: link.threadId,
    threadChatId: link.threadChatId,
    slackThreadLinkId: link.id,
    claimantToken: claim.claimantToken,
  });
}
