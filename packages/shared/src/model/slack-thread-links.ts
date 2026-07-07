import { and, desc, eq, isNull } from "drizzle-orm";
import type { DB } from "../db";
import * as schema from "../db/schema";
import type { SlackThreadLink, SlackThreadLinkInsert } from "../db/types";

export async function getActiveSlackThreadLink({
  db,
  teamId,
  channel,
  threadTs,
}: {
  db: DB;
  teamId: string;
  channel: string;
  threadTs: string;
}): Promise<SlackThreadLink | null> {
  const result = await db.query.slackThreadLinks.findFirst({
    where: and(
      eq(schema.slackThreadLinks.teamId, teamId),
      eq(schema.slackThreadLinks.channel, channel),
      eq(schema.slackThreadLinks.threadTs, threadTs),
      isNull(schema.slackThreadLinks.archivedAt),
      isNull(schema.slackThreadLinks.unlinkedAt),
    ),
  });
  return result || null;
}

export async function getSlackThreadLinkByThreadId({
  db,
  threadId,
}: {
  db: DB;
  threadId: string;
}): Promise<SlackThreadLink | null> {
  const result = await db.query.slackThreadLinks.findFirst({
    where: and(
      eq(schema.slackThreadLinks.threadId, threadId),
      isNull(schema.slackThreadLinks.archivedAt),
      isNull(schema.slackThreadLinks.unlinkedAt),
    ),
    orderBy: [desc(schema.slackThreadLinks.createdAt)],
  });
  return result || null;
}

export async function upsertSlackThreadLink({
  db,
  link,
}: {
  db: DB;
  link: Omit<SlackThreadLinkInsert, "id" | "createdAt" | "updatedAt">;
}): Promise<SlackThreadLink> {
  const now = new Date();
  const existing = await getActiveSlackThreadLink({
    db,
    teamId: link.teamId,
    channel: link.channel,
    threadTs: link.threadTs,
  });
  if (existing) {
    const [updated] = await db
      .update(schema.slackThreadLinks)
      .set({
        ...link,
        updatedAt: now,
      })
      .where(eq(schema.slackThreadLinks.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  const [inserted] = await db
    .insert(schema.slackThreadLinks)
    .values(link)
    .returning();
  if (!inserted) {
    throw new Error("Failed to create Slack thread link");
  }
  return inserted;
}

export async function setSlackThreadLinkMuteState({
  db,
  linkId,
  muted,
}: {
  db: DB;
  linkId: string;
  muted: boolean;
}) {
  await db
    .update(schema.slackThreadLinks)
    .set({ mutedAt: muted ? new Date() : null, updatedAt: new Date() })
    .where(eq(schema.slackThreadLinks.id, linkId));
}

export async function setSlackThreadLinkSleepState({
  db,
  linkId,
  sleepUntil,
}: {
  db: DB;
  linkId: string;
  sleepUntil: Date | null;
}) {
  await db
    .update(schema.slackThreadLinks)
    .set({
      sleepingAt: sleepUntil ? null : new Date(),
      sleepUntil,
      updatedAt: new Date(),
    })
    .where(eq(schema.slackThreadLinks.id, linkId));
}

export async function wakeSlackThreadLink({
  db,
  linkId,
}: {
  db: DB;
  linkId: string;
}) {
  await db
    .update(schema.slackThreadLinks)
    .set({ sleepingAt: null, sleepUntil: null, updatedAt: new Date() })
    .where(eq(schema.slackThreadLinks.id, linkId));
}

export async function archiveSlackThreadLink({
  db,
  linkId,
}: {
  db: DB;
  linkId: string;
}) {
  await db
    .update(schema.slackThreadLinks)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.slackThreadLinks.id, linkId));
}

export async function markSlackThreadLinkInbound({
  db,
  linkId,
  messageTs,
  actorSlackUserId,
}: {
  db: DB;
  linkId: string;
  messageTs: string;
  actorSlackUserId: string;
}) {
  await db
    .update(schema.slackThreadLinks)
    .set({
      lastInboundMessageTs: messageTs,
      lastActorSlackUserId: actorSlackUserId,
      updatedAt: new Date(),
    })
    .where(eq(schema.slackThreadLinks.id, linkId));
}
