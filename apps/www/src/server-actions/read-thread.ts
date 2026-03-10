"use server";

import {
  markThreadAsRead,
  markThreadChatAsRead,
} from "@terragon/shared/model/thread-read-status";
import { db } from "@/lib/db";
import { userOnlyAction } from "@/lib/auth-server";
import { getThreadMinimal } from "@terragon/shared/model/threads";

export const readThread = userOnlyAction(
  async function readThread(
    userId: string,
    {
      threadId,
      threadChatIdOrNull,
    }: {
      threadId: string;
      threadChatIdOrNull: string | null;
    },
  ) {
    console.log("readThread", { threadId, threadChatIdOrNull });
    const thread = await getThreadMinimal({
      db,
      userId,
      threadId,
    });
    if (!thread) {
      throw new Error("Thread not found");
    }
    if (threadChatIdOrNull) {
      await markThreadChatAsRead({
        db,
        userId,
        threadId,
        threadChatId: threadChatIdOrNull,
        shouldPublishRealtimeEvent: true,
      });
    } else {
      await markThreadAsRead({
        db,
        userId,
        threadId,
        shouldPublishRealtimeEvent: true,
      });
    }
  },
  { defaultErrorMessage: "An unexpected error occurred" },
);
