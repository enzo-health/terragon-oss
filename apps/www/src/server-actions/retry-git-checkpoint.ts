"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { waitUntil } from "@vercel/functions";
import { checkpointThread } from "../server-lib/checkpoint-thread";
import { transitionThreadChatLifecycle } from "@/server-lib/thread-lifecycle-command";
import { requireResult } from "@/lib/server-actions";
import { getThreadChat } from "@terragon/shared/model/threads";

export const retryGitCheckpoint = userOnlyAction(
  async function retryGitCheckpoint(
    userId: string,
    { threadId, threadChatId }: { threadId: string; threadChatId: string },
  ) {
    console.log("retryGitCheckpoint", {
      threadId,
      threadChatId,
    });
    await requireResult(
      () =>
        getThreadChat({
          db,
          threadId,
          threadChatId,
          userId,
        }),
      "Task not found",
    );
    const { didUpdateStatus } = await transitionThreadChatLifecycle({
      userId,
      threadId,
      threadChatId,
      eventType: "user.retry-checkpoint",
      chatUpdates: {
        errorMessage: null,
        errorMessageInfo: null,
      },
    });
    if (!didUpdateStatus) {
      throw new Error("Failed to update thread");
    }
    waitUntil(checkpointThread({ threadId, threadChatId, userId }));
  },
  { defaultErrorMessage: "Failed to retry git checkpoint" },
);
