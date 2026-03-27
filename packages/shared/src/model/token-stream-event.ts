import { and, asc, eq, gt } from "drizzle-orm";
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

  return db
    .insert(schema.tokenStreamEvent)
    .values(values)
    .onConflictDoNothing({
      target: schema.tokenStreamEvent.idempotencyKey,
    })
    .returning();
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
