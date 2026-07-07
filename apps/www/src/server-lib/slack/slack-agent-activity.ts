import crypto from "crypto";
import { WebClient } from "@slack/web-api";
import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import { env } from "@terragon/env/apps-www";
import { publicAppUrl } from "@terragon/env/next-public";
import * as schema from "@terragon/shared/db/schema";
import type {
  ThreadErrorType,
  ThreadSourceMetadata,
} from "@terragon/shared/db/types";
import { deriveDBMessagesFromCanonical } from "@terragon/shared/model/derive-db-messages-from-canonical";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import type { ThreadMinimal } from "@terragon/shared/model/threads";
import {
  getSlackInstallationForTeam,
  getSlackThreadLinkByThreadId,
} from "@terragon/shared/model/slack";
import { decryptValue } from "@terragon/utils/encryption";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { extractLastAssistantTextFromDBMessages } from "@/server-lib/linear-activity-from-canonical";

function getEventIdentity(canonicalEvents: readonly CanonicalEvent[]) {
  const lastEvent = canonicalEvents[canonicalEvents.length - 1] as
    | (CanonicalEvent & { eventId?: string; seq?: number; runId?: string })
    | undefined;
  return {
    eventId: lastEvent?.eventId ?? "unknown-event",
    seq: lastEvent?.seq ?? canonicalEvents.length,
    runId: lastEvent?.runId ?? "unknown-run",
  };
}

function hashPayload(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function claimOutboundDelivery({
  deliveryKey,
  linkId,
  threadId,
  threadChatId,
  teamId,
  channel,
  threadTs,
  kind,
  text,
}: {
  deliveryKey: string;
  linkId: string | null;
  threadId: string;
  threadChatId: string | null;
  teamId: string;
  channel: string;
  threadTs: string;
  kind: string;
  text: string;
}) {
  const now = new Date();
  const claimantToken = crypto.randomUUID();
  const inserted = await db
    .insert(schema.slackOutboundDeliveries)
    .values({
      deliveryKey,
      slackThreadLinkId: linkId,
      threadId,
      threadChatId,
      teamId,
      channel,
      threadTs,
      kind,
      status: "sending",
      payloadHash: hashPayload(text),
      claimantToken,
      claimedAt: now,
      claimExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
      attempts: 1,
    })
    .onConflictDoNothing()
    .returning({ deliveryKey: schema.slackOutboundDeliveries.deliveryKey });
  return inserted.length > 0 ? claimantToken : null;
}

function isSlackLinkSuppressed(
  link: NonNullable<Awaited<ReturnType<typeof getSlackThreadLinkByThreadId>>>,
) {
  return (
    link.mirrorMode === "off" ||
    Boolean(link.mutedAt) ||
    Boolean(link.archivedAt) ||
    Boolean(link.unlinkedAt) ||
    Boolean(link.sleepingAt) ||
    Boolean(link.sleepUntil && link.sleepUntil > new Date())
  );
}

function cleanSlackErrorInfo(errorInfo: string) {
  return errorInfo.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

function escapeSlackMrkdwn(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getSlackThreadErrorTitle(errorType: ThreadErrorType) {
  switch (errorType) {
    case "invalid-claude-credentials":
      return "Claude credentials expired";
    case "invalid-codex-credentials":
      return "Codex credentials expired";
    case "chatgpt-sub-required":
      return "ChatGPT subscription required";
    case "missing-gemini-credentials":
      return "Gemini API key required";
    case "missing-amp-credentials":
      return "Amp credentials required";
    case "prompt-too-long":
      return "Prompt is too long";
    case "queue-limit-exceeded":
      return "Task queue limit reached";
    case "sandbox-creation-failed":
      return "Sandbox failed to start";
    case "sandbox-resume-failed":
      return "Sandbox failed to resume";
    case "sandbox-not-found":
      return "Sandbox was not found";
    case "request-timeout":
      return "Task timed out";
    case "agent-not-responding":
      return "Agent is not responding";
    case "setup-script-failed":
      return "Setup script failed";
    case "git-checkpoint-diff-failed":
      return "Could not create a git diff";
    case "git-checkpoint-push-failed":
      return "Could not push changes";
    case "no-user-message":
      return "No prompt was found";
    case "unknown-error":
    case "agent-generic-error":
      return "Terragon hit an error";
  }
}

function getSlackThreadErrorDetail({
  errorType,
  errorInfo,
}: {
  errorType: ThreadErrorType;
  errorInfo: string;
}) {
  switch (errorType) {
    case "invalid-claude-credentials":
      return "Update your Claude credentials in Terragon settings, then retry the task.";
    case "invalid-codex-credentials":
      return "Update your Codex credentials in Terragon settings, then retry the task.";
    case "chatgpt-sub-required":
      return "Connect a ChatGPT account with the required subscription, then retry the task.";
    case "prompt-too-long":
      return "Try a shorter prompt or split the request into smaller tasks.";
    case "queue-limit-exceeded":
      return "Wait for an active task to finish, then retry.";
    default: {
      const cleanInfo = cleanSlackErrorInfo(errorInfo);
      return cleanInfo || "Open the Terragon task for details.";
    }
  }
}

type SlackErrorTarget = {
  linkId: string | null;
  teamId: string;
  channel: string;
  threadTs: string;
};

function resolveSlackErrorTarget({
  thread,
  link,
}: {
  thread: ThreadMinimal;
  link: Awaited<ReturnType<typeof getSlackThreadLinkByThreadId>>;
}): SlackErrorTarget | null {
  if (link) {
    if (isSlackLinkSuppressed(link)) {
      return null;
    }
    return {
      linkId: link.id,
      teamId: link.teamId,
      channel: link.channel,
      threadTs: link.threadTs,
    };
  }

  if (thread.sourceType !== "slack-mention") {
    return null;
  }

  const sourceMetadata = thread.sourceMetadata as ThreadSourceMetadata | null;
  if (
    sourceMetadata?.type !== "slack-mention" ||
    typeof sourceMetadata.teamId !== "string" ||
    typeof sourceMetadata.channel !== "string" ||
    typeof sourceMetadata.messageTs !== "string"
  ) {
    return null;
  }

  return {
    linkId: null,
    teamId: sourceMetadata.teamId,
    channel: sourceMetadata.channel,
    threadTs: sourceMetadata.threadTs || sourceMetadata.messageTs,
  };
}

export function formatSlackThreadErrorNotification({
  threadId,
  errorType,
  errorInfo,
}: {
  threadId: string;
  errorType: ThreadErrorType;
  errorInfo: string;
}) {
  const taskUrl = `${publicAppUrl()}/task/${threadId}`;
  const title = getSlackThreadErrorTitle(errorType);
  const detail = getSlackThreadErrorDetail({ errorType, errorInfo });
  return `:warning: ${title}\n\n${detail}\n\n${taskUrl}`;
}

export function formatSlackThreadErrorBlocks({
  threadId,
  errorType,
  errorInfo,
}: {
  threadId: string;
  errorType: ThreadErrorType;
  errorInfo: string;
}) {
  const taskUrl = `${publicAppUrl()}/task/${threadId}`;
  const title = getSlackThreadErrorTitle(errorType);
  const detail = getSlackThreadErrorDetail({ errorType, errorInfo });
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: *${escapeSlackMrkdwn(title)}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: escapeSlackMrkdwn(detail),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Open task",
            emoji: true,
          },
          url: taskUrl,
          action_id: "open_failed_task",
          style: "primary",
        },
      ],
    },
  ];
}

export async function emitSlackThreadErrorNotification({
  thread,
  threadId,
  threadChatId,
  errorType,
  errorInfo,
}: {
  thread: ThreadMinimal;
  threadId: string;
  threadChatId: string | null;
  errorType: ThreadErrorType;
  errorInfo: string;
}) {
  if (thread.sourceType !== "slack-mention") {
    return;
  }

  const link = await getSlackThreadLinkByThreadId({ db, threadId });
  const target = resolveSlackErrorTarget({ thread, link });
  if (!target) {
    return;
  }

  const installation = await getSlackInstallationForTeam({
    db,
    teamId: target.teamId,
  });
  if (!installation) {
    return;
  }

  const text = formatSlackThreadErrorNotification({
    threadId,
    errorType,
    errorInfo,
  });
  const blocks = formatSlackThreadErrorBlocks({
    threadId,
    errorType,
    errorInfo,
  });
  const deliveryKey = [
    "slack-error",
    target.linkId ?? "source",
    threadId,
    threadChatId ?? "no-chat",
    hashPayload(`${errorType}:${errorInfo}`).slice(0, 16),
  ].join(":");
  const claimantToken = await claimOutboundDelivery({
    deliveryKey,
    linkId: target.linkId,
    threadId,
    threadChatId,
    teamId: target.teamId,
    channel: target.channel,
    threadTs: target.threadTs,
    kind: "error",
    text,
  });
  if (!claimantToken) {
    return;
  }

  const slack = new WebClient(
    decryptValue(
      installation.botAccessTokenEncrypted,
      env.ENCRYPTION_MASTER_KEY,
    ),
  );
  try {
    const result = await slack.chat.postMessage({
      channel: target.channel,
      thread_ts: target.threadTs,
      text,
      blocks,
    });
    await completeOutboundDelivery({
      deliveryKey,
      claimantToken,
      messageTs: typeof result.ts === "string" ? result.ts : undefined,
    });
  } catch (error) {
    await failOutboundDelivery({ deliveryKey, claimantToken, error });
  }
}

async function completeOutboundDelivery({
  deliveryKey,
  claimantToken,
  messageTs,
}: {
  deliveryKey: string;
  claimantToken: string;
  messageTs?: string;
}) {
  await db
    .update(schema.slackOutboundDeliveries)
    .set({
      status: "sent",
      messageTs,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.slackOutboundDeliveries.deliveryKey, deliveryKey),
        eq(schema.slackOutboundDeliveries.claimantToken, claimantToken),
      ),
    );
}

async function failOutboundDelivery({
  deliveryKey,
  claimantToken,
  error,
}: {
  deliveryKey: string;
  claimantToken: string;
  error: unknown;
}) {
  await db
    .update(schema.slackOutboundDeliveries)
    .set({
      status: "retryable_failed",
      lastError: error instanceof Error ? error.message : String(error),
      nextAttemptAt: new Date(Date.now() + 60_000),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.slackOutboundDeliveries.deliveryKey, deliveryKey),
        eq(schema.slackOutboundDeliveries.claimantToken, claimantToken),
      ),
    );
}

export async function emitSlackActivitiesForCanonicalBatch({
  threadId,
  threadChatId,
  canonicalEvents,
  isDone,
  isError,
  isRecoveryFire,
  customErrorMessage,
}: {
  threadId: string;
  threadChatId: string;
  canonicalEvents: readonly CanonicalEvent[];
  isDone: boolean;
  isError: boolean;
  isRecoveryFire: boolean;
  customErrorMessage?: string | null;
}) {
  if (canonicalEvents.length === 0 || isRecoveryFire) {
    return;
  }

  const link = await getSlackThreadLinkByThreadId({ db, threadId });
  if (!link || isSlackLinkSuppressed(link)) {
    return;
  }

  const enabled = await getFeatureFlagForUser({
    db,
    userId: link.userId,
    flagName: "slackLiveThreadUpdates",
  });
  if (!enabled) {
    return;
  }

  const dbMessages = deriveDBMessagesFromCanonical(canonicalEvents);
  const lastAssistantText = extractLastAssistantTextFromDBMessages(dbMessages);
  const kind = isDone || isError ? "terminal" : "status";
  const body = isError
    ? customErrorMessage?.trim() || "Terragon hit an error."
    : isDone
      ? lastAssistantText || "Task completed."
      : lastAssistantText;
  if (!body) {
    return;
  }

  const installation = await getSlackInstallationForTeam({
    db,
    teamId: link.teamId,
  });
  if (!installation) {
    return;
  }

  const identity = getEventIdentity(canonicalEvents);
  const deliveryKey = [
    "slack-out",
    link.id,
    identity.runId,
    identity.eventId,
    identity.seq,
    kind,
  ].join(":");
  const text =
    kind === "terminal"
      ? `${body}\n\n${publicAppUrl()}/task/${threadId}`
      : `Terragon update: ${body}`;
  const claimantToken = await claimOutboundDelivery({
    deliveryKey,
    linkId: link.id,
    threadId,
    threadChatId,
    teamId: link.teamId,
    channel: link.channel,
    threadTs: link.threadTs,
    kind,
    text,
  });
  if (!claimantToken) {
    return;
  }

  const slack = new WebClient(
    decryptValue(
      installation.botAccessTokenEncrypted,
      env.ENCRYPTION_MASTER_KEY,
    ),
  );
  try {
    const result = await slack.chat.postMessage({
      channel: link.channel,
      thread_ts: link.threadTs,
      text,
    });
    await completeOutboundDelivery({
      deliveryKey,
      claimantToken,
      messageTs: typeof result.ts === "string" ? result.ts : undefined,
    });
  } catch (error) {
    await failOutboundDelivery({ deliveryKey, claimantToken, error });
  }
}
