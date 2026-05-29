"use server";

import { markThreadChatAsUnread } from "@terragon/shared/model/thread-read-status";
import { db } from "@/lib/db";
import { userOnlyAction } from "@/lib/auth-server";
import { getThread } from "@terragon/shared/model/threads";

export const unreadThread = userOnlyAction(
  async function unreadThread(
    userId: string,
    { threadId }: { threadId: string },
  ) {
    console.log("unreadThread", threadId);
    const thread = await getThread({
      db,
      userId,
      threadId,
    });
    if (!thread) {
      throw new Error("Thread not found");
    }
    await markThreadChatAsUnread({
      db,
      userId,
      threadId,
      threadChatIdOrNull: null,
      shouldPublishRealtimeEvent: true,
    });
  },
  { defaultErrorMessage: "An unexpected error occurred" },
);
