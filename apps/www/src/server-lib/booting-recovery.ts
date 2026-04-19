import { DB } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import { and, eq, lte } from "drizzle-orm";
import { updateThreadChatStatusAtomic } from "@terragon/shared/model/threads";

export async function getStaleBootingThreadChats({
  db,
  maxAgeMs,
}: {
  db: DB;
  maxAgeMs: number;
}) {
  return db
    .select({
      id: schema.threadChat.id,
      threadId: schema.threadChat.threadId,
      userId: schema.threadChat.userId,
      status: schema.threadChat.status,
      updatedAt: schema.threadChat.updatedAt,
    })
    .from(schema.threadChat)
    .where(
      and(
        eq(schema.threadChat.status, "booting"),
        lte(schema.threadChat.updatedAt, new Date(Date.now() - maxAgeMs)),
      ),
    );
}

export async function requeueStaleBootingThreadChats({
  db,
  threadChats,
}: {
  db: DB;
  threadChats: Array<{
    id: string;
    threadId: string;
    userId: string;
  }>;
}) {
  let requeuedCount = 0;
  for (const tc of threadChats) {
    try {
      const updated = await updateThreadChatStatusAtomic({
        db,
        userId: tc.userId,
        threadId: tc.threadId,
        threadChatId: tc.id,
        fromStatus: "booting",
        toStatus: "queued-tasks-concurrency",
      });
      if (updated) {
        requeuedCount++;
        console.log(
          `Requeued stale booting thread chat ${tc.id} (thread ${tc.threadId})`,
        );
      }
    } catch (error) {
      console.error(
        `Failed to requeue stale booting thread chat ${tc.id}`,
        error,
      );
    }
  }
  return { requeuedCount };
}
