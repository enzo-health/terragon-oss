"use server";

import { cache } from "react";
import { db } from "@/lib/db";
import { userOnlyAction } from "@/lib/auth-server";
import { UserFacingError } from "@/lib/server-actions";
import { ThreadPageChat } from "@leo/shared/db/types";
import { getThreadPageChatWithPermissions } from "@leo/shared/model/thread-page";
import { getHasRepoPermissionsForUser } from "./get-thread";

export const getThreadPageChatAction = cache(
  userOnlyAction(
    async function getThreadPageChatAction(
      userId: string,
      params: {
        threadId: string;
        threadChatId: string;
      },
    ): Promise<ThreadPageChat> {
      const threadChat = await getThreadPageChatWithPermissions({
        db,
        threadId: params.threadId,
        threadChatId: params.threadChatId,
        userId,
        allowAdmin: false,
        getHasRepoPermissions: async (repoFullName) =>
          getHasRepoPermissionsForUser({ userId, repoFullName }),
      });

      if (!threadChat) {
        throw new UserFacingError("Unauthorized");
      }

      return threadChat;
    },
    { defaultErrorMessage: "Failed to get task chat" },
  ),
);
