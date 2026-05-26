import type { DBMessage } from "@terragon/shared";
import * as schema from "@terragon/shared/db/schema";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";

export type AuthorizedAgUiThreadChat = {
  id: string;
  messages: DBMessage[];
};

export async function authorizeAgUiThreadChat({
  threadId,
  threadChatId,
  userId,
}: {
  threadId: string;
  threadChatId: string;
  userId: string;
}): Promise<AuthorizedAgUiThreadChat | null> {
  const rows = await db
    .select({
      id: schema.threadChat.id,
      messages: schema.threadChat.messages,
    })
    .from(schema.threadChat)
    .innerJoin(schema.thread, eq(schema.threadChat.threadId, schema.thread.id))
    .where(
      and(
        eq(schema.threadChat.id, threadChatId),
        eq(schema.thread.id, threadId),
        eq(schema.thread.userId, userId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    messages: row.messages ?? [],
  };
}
