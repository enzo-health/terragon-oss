"use server";

import { updateThreadChatWithTransition } from "@/agent/update-status";
import { userOnlyAction } from "@/lib/auth-server";
import { runScheduledThread as runScheduledThreadInternal } from "@/server-lib/scheduled-thread";

export const runScheduledThread = userOnlyAction(
  async function runScheduledThread(
    userId: string,
    { threadId, threadChatId }: { threadId: string; threadChatId: string },
  ) {
    console.log("runScheduledThread", { threadId, threadChatId });
    await runScheduledThreadInternal({ threadId, threadChatId, userId });
  },
  { defaultErrorMessage: "Failed to run scheduled task" },
);

export const cancelScheduledThread = userOnlyAction(
  async function cancelScheduledThread(
    userId: string,
    { threadId, threadChatId }: { threadId: string; threadChatId: string },
  ) {
    console.log("cancelScheduledThread", { threadId, threadChatId });
    const cancelMessage = {
      type: "system" as const,
      message_type: "cancel-schedule" as const,
      parts: [],
    };
    const { didUpdateStatus } = await updateThreadChatWithTransition({
      userId,
      threadId,
      threadChatId,
      eventType: "user.cancel-schedule",
      chatUpdates: {
        scheduleAt: null,
        appendMessages: [cancelMessage],
      },
    });
    if (!didUpdateStatus) {
      throw new Error("Failed to update thread");
    }
  },
  { defaultErrorMessage: "Failed to cancel scheduled thread" },
);
