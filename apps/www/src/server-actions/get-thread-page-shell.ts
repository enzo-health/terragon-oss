"use server";

import { cache } from "react";
import { db } from "@/lib/db";
import { userOnlyAction } from "@/lib/auth-server";
import { UserFacingError } from "@/lib/server-actions";
import { ThreadPageShell } from "@leo/shared/db/types";
import { getThreadPageShellWithPermissions } from "@leo/shared/model/thread-page";
import { getHasRepoPermissionsForUser } from "./get-thread";

export const getThreadPageShellAction = cache(
  userOnlyAction(
    async function getThreadPageShellAction(
      userId: string,
      threadId: string,
    ): Promise<ThreadPageShell> {
      const threadShell = await getThreadPageShellWithPermissions({
        db,
        threadId,
        userId,
        allowAdmin: false,
        getHasRepoPermissions: async (repoFullName) =>
          getHasRepoPermissionsForUser({ userId, repoFullName }),
      });

      if (!threadShell) {
        throw new UserFacingError("Unauthorized");
      }

      return threadShell;
    },
    { defaultErrorMessage: "Failed to get task" },
  ),
);
