"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getThread, deleteThreadById } from "@leo/shared/model/threads";
import { stopThread } from "./stop-thread";
import { isAgentWorking } from "@/agent/thread-status";
import { getPostHogServer } from "@/lib/posthog-server";
import { unwrapResult, UserFacingError } from "@/lib/server-actions";

export const deleteThread = userOnlyAction(
  async function deleteThread(userId: string, threadId: string) {
    console.log("deleteThread", threadId);
    getPostHogServer().capture({
      distinctId: userId,
      event: "delete_thread",
      properties: {
        threadId,
      },
    });
    // Get the thread to check its current status and ownership
    const thread = await getThread({
      db,
      userId,
      threadId,
    });
    if (!thread) {
      throw new UserFacingError("Task not found");
    }
    await Promise.all(
      thread.threadChats.map(async (threadChat) => {
        if (isAgentWorking(threadChat.status)) {
          unwrapResult(
            await stopThread({ threadId, threadChatId: threadChat.id }),
          );
        }
      }),
    );
    // Delete the thread using the shared model function
    await deleteThreadById({ db, threadId, userId });
  },
  { defaultErrorMessage: "Failed to delete task" },
);
