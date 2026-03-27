import { and, asc, eq, gt, sql } from "drizzle-orm";
import { DB } from "../db";
import * as schema from "../db/schema";
import { TokenStreamEvent, TokenStreamEventInsert } from "../db/types";

export type TokenStreamEventInput = {
  userId: string;
  threadId: string;
  threadChatId: string;
  messageId: string;
  partIndex: number;
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
    threadId: event.threadId,
    threadChatId: event.threadChatId,
    messageId: event.messageId,
    partIndex: event.partIndex,
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

export async function replayTokenStreamEventsFromSeq({
  db,
  userId,
  threadId,
  threadChatId,
  fromSeq,
}: {
  db: DB;
  userId: string;
  threadId: string;
  threadChatId: string;
  fromSeq: number;
}): Promise<TokenStreamEvent[]> {
  return db.query.tokenStreamEvent.findMany({
    where: and(
      eq(schema.tokenStreamEvent.userId, userId),
      eq(schema.tokenStreamEvent.threadId, threadId),
      eq(schema.tokenStreamEvent.threadChatId, threadChatId),
      gt(schema.tokenStreamEvent.streamSeq, fromSeq),
    ),
    orderBy: [asc(schema.tokenStreamEvent.streamSeq)],
  });
}
