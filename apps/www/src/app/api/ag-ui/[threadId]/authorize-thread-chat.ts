import type { DBMessage } from "@terragon/shared";
import * as schema from "@terragon/shared/db/schema";
import { getAuthorizedThreadAccess } from "@terragon/shared/model/thread-auth";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { getHasRepoPermissionsForUser } from "@/server-actions/get-thread";

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
  const access = await getAuthorizedThreadAccess({
    db,
    threadId,
    userId,
    allowAdmin: false,
    getHasRepoPermissions: async (repoFullName) =>
      getHasRepoPermissionsForUser({ userId, repoFullName }),
  });
  if (!access) {
    return null;
  }

  const rows = await db
    .select({
      id: schema.threadChat.id,
      messages: schema.threadChat.messages,
    })
    .from(schema.threadChat)
    .where(
      and(
        eq(schema.threadChat.id, threadChatId),
        eq(schema.threadChat.threadId, threadId),
        eq(schema.threadChat.userId, access.ownerUserId),
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
