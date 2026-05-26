"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { waitUntil } from "@vercel/functions";
import { checkpointThread } from "../server-lib/checkpoint-thread";
import { getPostHogServer } from "@/lib/posthog-server";
import { updateThreadChatWithTransition } from "@/agent/update-status";
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
    getPostHogServer().capture({
      distinctId: userId,
      event: "retry_git_checkpoint",
      properties: {
        threadId,
        threadChatId,
      },
    });
    const { didUpdateStatus } = await updateThreadChatWithTransition({
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
