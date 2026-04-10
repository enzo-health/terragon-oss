"use server";

import { updateThreadVisibility } from "@leo/shared/model/thread-visibility";
import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { ThreadVisibility } from "@leo/shared/db/types";

export const updateThreadVisibilityAction = userOnlyAction(
  async function updateThreadVisibilityAction(
    userId: string,
    {
      threadId,
      visibility,
    }: {
      threadId: string;
      visibility: ThreadVisibility;
    },
  ) {
    await updateThreadVisibility({ db, userId, threadId, visibility });
  },
  { defaultErrorMessage: "Failed to update task visibility" },
);
