"use server";

import { cache } from "react";
import { db } from "@/lib/db";
import { userOnlyAction } from "@/lib/auth-server";
import { UserFacingError } from "@/lib/server-actions";
import { ThreadPageDiff } from "@terragon/shared/db/types";
import { getThreadPageDiffWithPermissions } from "@terragon/shared/model/thread-page";
import { getHasRepoPermissionsForUser } from "./get-thread";

export const getThreadPageDiffAction = cache(
  userOnlyAction(
    async function getThreadPageDiffAction(
      userId: string,
      threadId: string,
    ): Promise<ThreadPageDiff> {
      const threadDiff = await getThreadPageDiffWithPermissions({
        db,
        threadId,
        userId,
        allowAdmin: false,
        getHasRepoPermissions: async (repoFullName) =>
          getHasRepoPermissionsForUser({ userId, repoFullName }),
      });

      if (!threadDiff) {
        throw new UserFacingError("Unauthorized");
      }

      return threadDiff;
    },
    { defaultErrorMessage: "Failed to get task diff" },
  ),
);
