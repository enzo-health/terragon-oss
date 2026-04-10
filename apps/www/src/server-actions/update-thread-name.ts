"use server";

import { db } from "@/lib/db";
import { userOnlyAction } from "@/lib/auth-server";
import { updateThread } from "@leo/shared/model/threads";
import { UserFacingError } from "@/lib/server-actions";

export const updateThreadName = userOnlyAction(
  async function updateThreadName(
    userId: string,
    {
      threadId,
      name,
    }: {
      threadId: string;
      name: string;
    },
  ) {
    // Trim the name and ensure it's not empty
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new UserFacingError("Task name cannot be empty");
    }
    await updateThread({
      db,
      userId,
      threadId,
      updates: {
        name: trimmedName,
      },
    });
  },
  {
    defaultErrorMessage: "Failed to update task name",
  },
);
