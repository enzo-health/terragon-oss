import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { DB } from "../db";
import * as schema from "../db/schema";
import { TokenStreamEvent, TokenStreamEventInsert } from "../db/types";

export type TokenStreamEventInput = {
  userId: string;
  runId: string;
  threadId: string;
  threadChatId: string;
  messageId: string;
  partIndex: number;
  partType: "text" | "thinking";
  text: string;
  idempotencyKey: string;
};

export async function appendTokenStreamEvents({
  db,
  events,
}: {
  db: DB;
  events: TokenStreamEventInput[];
}): Promise<TokenStreamEvent[]> {
  if (events.length === 0) {
    return [];
  }

  const values: TokenStreamEventInsert[] = events.map((event) => ({
    userId: event.userId,
    runId: event.runId,
    threadId: event.threadId,
    threadChatId: event.threadChatId,
    threadChatMessageSeq: null,
    messageId: event.messageId,
    partIndex: event.partIndex,
    partType: event.partType,
    text: event.text,
    idempotencyKey: event.idempotencyKey,
  }));

  const insertedOrExisting = await db
    .insert(schema.tokenStreamEvent)
    .values(values)
    .onConflictDoUpdate({
      target: schema.tokenStreamEvent.idempotencyKey,
      // No-op update to return the existing row (with streamSeq) on retries.
      set: {
        idempotencyKey: sql`${schema.tokenStreamEvent.idempotencyKey}`,
      },
    })
    .returning();
  return insertedOrExisting.sort((a, b) => a.streamSeq - b.streamSeq);
}

export async function assignPendingTokenStreamEventsToThreadChatMessageSeq({
  db,
  runId,
  threadChatId,
  threadChatMessageSeq,
  maxStreamSeq,
}: {
  db: DB;
  runId: string;
  threadChatId: string;
  threadChatMessageSeq: number;
  maxStreamSeq: number;
}): Promise<void> {
  await db
    .update(schema.tokenStreamEvent)
    .set({ threadChatMessageSeq })
    .where(
      and(
        eq(schema.tokenStreamEvent.runId, runId),
        eq(schema.tokenStreamEvent.threadChatId, threadChatId),
        lte(schema.tokenStreamEvent.streamSeq, maxStreamSeq),
        isNull(schema.tokenStreamEvent.threadChatMessageSeq),
      ),
    );
}

export async function getPendingTokenStreamEventFinalizationUpperBound({
  db,
  runId,
  threadChatId,
}: {
  db: DB;
  runId: string;
  threadChatId: string;
}): Promise<number | null> {
  const row = await db.query.tokenStreamEvent.findFirst({
    where: and(
      eq(schema.tokenStreamEvent.runId, runId),
      eq(schema.tokenStreamEvent.threadChatId, threadChatId),
      isNull(schema.tokenStreamEvent.threadChatMessageSeq),
    ),
    columns: {
      streamSeq: true,
    },
    orderBy: [desc(schema.tokenStreamEvent.streamSeq)],
  });

  return row?.streamSeq ?? null;
}

export async function replayPendingTokenStreamEventsForActiveRun({
  db,
  userId,
  threadId,
  threadChatId,
}: {
  db: DB;
  userId: string;
  threadId: string;
  threadChatId: string;
}): Promise<TokenStreamEvent[]> {
  const activeRun = await db.query.agentRunContext.findFirst({
    where: and(
      eq(schema.agentRunContext.threadId, threadId),
      eq(schema.agentRunContext.threadChatId, threadChatId),
      inArray(schema.agentRunContext.status, [
        "pending",
        "dispatched",
        "processing",
      ]),
    ),
    columns: {
      runId: true,
    },
    orderBy: [desc(schema.agentRunContext.updatedAt)],
  });

  if (!activeRun) {
    return [];
  }

  return db.query.tokenStreamEvent.findMany({
    where: and(
      eq(schema.tokenStreamEvent.userId, userId),
      eq(schema.tokenStreamEvent.runId, activeRun.runId),
      eq(schema.tokenStreamEvent.threadId, threadId),
      eq(schema.tokenStreamEvent.threadChatId, threadChatId),
      isNull(schema.tokenStreamEvent.threadChatMessageSeq),
    ),
    orderBy: [asc(schema.tokenStreamEvent.streamSeq)],
  });
}
