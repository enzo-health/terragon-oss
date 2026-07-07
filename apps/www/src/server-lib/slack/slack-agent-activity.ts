import crypto from "crypto";
import { WebClient } from "@slack/web-api";
import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import { env } from "@terragon/env/apps-www";
import { publicAppUrl } from "@terragon/env/next-public";
import * as schema from "@terragon/shared/db/schema";
import { deriveDBMessagesFromCanonical } from "@terragon/shared/model/derive-db-messages-from-canonical";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
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
  linkId: string;
  threadId: string;
  threadChatId: string;
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
  if (
    !link ||
    link.mirrorMode === "off" ||
    link.mutedAt ||
    link.archivedAt ||
    link.unlinkedAt ||
    link.sleepingAt ||
    (link.sleepUntil && link.sleepUntil > new Date())
  ) {
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
