"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { stopThread as stopThreadInternal } from "@/server-lib/stop-thread";

export const stopThread = userOnlyAction(
  async function stopThread(
    userId: string,
    { threadId, threadChatId }: { threadId: string; threadChatId: string },
  ) {
    console.log("stopThread", threadId);
    await stopThreadInternal({
      userId,
      threadId,
      threadChatId,
    });
  },
  { defaultErrorMessage: "Failed to stop task" },
);
