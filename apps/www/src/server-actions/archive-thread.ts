"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { updateThread } from "@leo/shared/model/threads";
import { getPostHogServer } from "@/lib/posthog-server";
import { archiveAndStopThread } from "@/server-lib/archive-thread";

export const archiveThread = userOnlyAction(
  async function archiveThread(userId: string, threadId: string) {
    console.log("archiveThread", threadId);
    await archiveAndStopThread({ userId, threadId });
  },
  { defaultErrorMessage: "Failed to archive task" },
);

export const unarchiveThread = userOnlyAction(
  async function unarchiveThread(userId: string, threadId: string) {
    console.log("unarchiveThread", threadId);
    getPostHogServer().capture({
      distinctId: userId,
      event: "unarchive_thread",
      properties: {
        threadId,
      },
    });
    await updateThread({
      db,
      userId,
      threadId,
      updates: {
        archived: false,
        updatedAt: new Date(),
      },
    });
  },
  { defaultErrorMessage: "Failed to unarchive task" },
);
