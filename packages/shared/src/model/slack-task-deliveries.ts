import { randomUUID } from "crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { DB } from "../db";
import * as schema from "../db/schema";

const CLAIM_LEASE_MS = 5 * 60 * 1000;

export function getSlackTaskDeliveryKey({
  teamId,
  channel,
  messageTs,
  actionId,
  actorSlackUserId,
  actionTs,
  triggerId,
}: {
  teamId: string;
  channel: string;
  messageTs: string;
  actionId?: string | null;
  actorSlackUserId?: string | null;
  actionTs?: string | null;
  triggerId?: string | null;
}) {
  if (actionId) {
    return [
      teamId,
      channel,
      messageTs,
      actionId,
      actorSlackUserId ?? "unknown-actor",
      actionTs ?? triggerId ?? "unknown-action-ts",
    ].join(":");
  }
  return `${teamId}:${channel}:${messageTs}`;
}

export async function claimSlackTaskDelivery({
  db,
  teamId,
  channel,
  messageTs,
  slackEventId,
  action = "create",
  actionId,
  actorSlackUserId,
  actionTs,
  triggerId,
}: {
  db: DB;
  teamId: string;
  channel: string;
  messageTs: string;
  slackEventId?: string | null;
  action?: "create" | "follow-up" | "command";
  actionId?: string | null;
  actorSlackUserId?: string | null;
  actionTs?: string | null;
  triggerId?: string | null;
}): Promise<{ claimed: boolean; claimantToken?: string; deliveryKey: string }> {
  const deliveryKey = getSlackTaskDeliveryKey({
    teamId,
    channel,
    messageTs,
    actionId,
    actorSlackUserId,
    actionTs,
    triggerId,
  });
  const now = new Date();
  const claimantToken = randomUUID();
  const claimExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
  const inserted = await db
    .insert(schema.slackTaskDeliveries)
    .values({
      deliveryKey,
      teamId,
      channel,
      messageTs,
      slackEventId,
      action,
      status: "claimed",
      claimantToken,
      claimExpiresAt,
      claimedAt: now,
    })
    .onConflictDoNothing()
    .returning({ deliveryKey: schema.slackTaskDeliveries.deliveryKey });

  if (inserted.length > 0) {
    return { claimed: true, claimantToken, deliveryKey };
  }

  const existing = await db.query.slackTaskDeliveries.findFirst({
    where: eq(schema.slackTaskDeliveries.deliveryKey, deliveryKey),
  });
  if (
    !existing ||
    existing.completedAt !== null ||
    existing.status === "completed" ||
    existing.status === "ignored" ||
    existing.status === "omitted"
  ) {
    return { claimed: false, deliveryKey };
  }

  if (existing.claimExpiresAt && existing.claimExpiresAt > now) {
    return { claimed: false, deliveryKey };
  }

  const stolen = await db
    .update(schema.slackTaskDeliveries)
    .set({
      status: "claimed",
      claimantToken,
      claimExpiresAt,
      claimedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.slackTaskDeliveries.deliveryKey, deliveryKey),
        or(
          isNull(schema.slackTaskDeliveries.claimExpiresAt),
          lt(schema.slackTaskDeliveries.claimExpiresAt, now),
        ),
        isNull(schema.slackTaskDeliveries.completedAt),
      ),
    )
    .returning({ deliveryKey: schema.slackTaskDeliveries.deliveryKey });
  return {
    claimed: stolen.length > 0,
    claimantToken: stolen.length > 0 ? claimantToken : undefined,
    deliveryKey,
  };
}

export async function completeSlackTaskDelivery({
  db,
  teamId,
  channel,
  messageTs,
  deliveryKey,
  threadId,
  threadChatId,
  slackThreadLinkId,
  claimantToken,
}: {
  db: DB;
  teamId: string;
  channel: string;
  messageTs: string;
  deliveryKey?: string;
  threadId: string;
  threadChatId?: string | null;
  slackThreadLinkId?: string | null;
  claimantToken?: string;
}): Promise<void> {
  const finalDeliveryKey =
    deliveryKey ?? getSlackTaskDeliveryKey({ teamId, channel, messageTs });
  const completedAt = new Date();
  if (claimantToken) {
    const updated = await db
      .update(schema.slackTaskDeliveries)
      .set({
        threadId,
        threadChatId,
        slackThreadLinkId,
        completedAt,
        status: "completed",
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(schema.slackTaskDeliveries.deliveryKey, finalDeliveryKey),
          eq(schema.slackTaskDeliveries.claimantToken, claimantToken),
        ),
      )
      .returning({ deliveryKey: schema.slackTaskDeliveries.deliveryKey });
    if (updated.length > 0) {
      return;
    }
  }
  await db
    .insert(schema.slackTaskDeliveries)
    .values({
      deliveryKey: finalDeliveryKey,
      teamId,
      channel,
      messageTs,
      threadId,
      threadChatId,
      slackThreadLinkId,
      completedAt,
      status: "completed",
    })
    .onConflictDoUpdate({
      target: schema.slackTaskDeliveries.deliveryKey,
      set: {
        threadId,
        threadChatId,
        slackThreadLinkId,
        completedAt,
        status: "completed",
        updatedAt: completedAt,
      },
    });
}

export async function markSlackTaskDeliveryOmitted({
  db,
  deliveryKey,
  omittedReason,
  claimantToken,
}: {
  db: DB;
  deliveryKey: string;
  omittedReason: string;
  claimantToken?: string;
}) {
  await db
    .update(schema.slackTaskDeliveries)
    .set({
      status: "omitted",
      omittedReason,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      claimantToken
        ? and(
            eq(schema.slackTaskDeliveries.deliveryKey, deliveryKey),
            eq(schema.slackTaskDeliveries.claimantToken, claimantToken),
          )
        : eq(schema.slackTaskDeliveries.deliveryKey, deliveryKey),
    );
}

export async function markSlackTaskDeliveryIgnored({
  db,
  deliveryKey,
  ignoredReason,
  claimantToken,
}: {
  db: DB;
  deliveryKey: string;
  ignoredReason: string;
  claimantToken?: string;
}) {
  await db
    .update(schema.slackTaskDeliveries)
    .set({
      status: "ignored",
      ignoredReason,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      claimantToken
        ? and(
            eq(schema.slackTaskDeliveries.deliveryKey, deliveryKey),
            eq(schema.slackTaskDeliveries.claimantToken, claimantToken),
          )
        : eq(schema.slackTaskDeliveries.deliveryKey, deliveryKey),
    );
}

export async function markSlackTaskDeliveryFailed({
  db,
  deliveryKey,
  lastError,
  claimantToken,
}: {
  db: DB;
  deliveryKey: string;
  lastError: string;
  claimantToken?: string;
}) {
  await db
    .update(schema.slackTaskDeliveries)
    .set({
      status: "failed",
      lastError,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      claimantToken
        ? and(
            eq(schema.slackTaskDeliveries.deliveryKey, deliveryKey),
            eq(schema.slackTaskDeliveries.claimantToken, claimantToken),
          )
        : eq(schema.slackTaskDeliveries.deliveryKey, deliveryKey),
    );
}
