"use server";

import { cache } from "react";
import { getThreadWithPermissions } from "@terragon/shared/model/threads";
import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getOctokitForUser, parseRepoFullName } from "@/lib/github";
import { ThreadInfoFull } from "@terragon/shared/db/types";
import { UserFacingError } from "@/lib/server-actions";

export async function getHasRepoPermissionsForUser({
  userId,
  repoFullName,
}: {
  userId: string;
  repoFullName: string;
}): Promise<boolean> {
  const octokit = await getOctokitForUser({ userId });
  if (!octokit) {
    return false;
  }

  try {
    const [owner, repo] = parseRepoFullName(repoFullName);
    const repoInfo = await octokit.rest.repos.get({
      owner,
      repo,
    });
    if (!repoInfo.data.permissions) {
      return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

export async function getThreadWithUserPermissions({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}): Promise<ThreadInfoFull | null> {
  const threadInfoFull = await getThreadWithPermissions({
    db,
    threadId,
    userId,
    allowAdmin: false,
    getHasRepoPermissions: async (repoFullName) => {
      return await getHasRepoPermissionsForUser({ userId, repoFullName });
    },
  });

  return threadInfoFull ?? null;
}

Object.assign(getHasRepoPermissionsForUser, {
  userOnly: true,
  wrappedServerAction: true,
});

Object.assign(getThreadWithUserPermissions, {
  userOnly: true,
  wrappedServerAction: true,
});

export const getThreadAction = cache(
  userOnlyAction(
    async function getThreadAction(
      userId: string,
      threadId: string,
    ): Promise<ThreadInfoFull> {
      const threadInfoFull = await getThreadWithUserPermissions({
        userId,
        threadId,
      });
      if (!threadInfoFull) {
        throw new UserFacingError("Unauthorized");
      }
      return threadInfoFull;
    },
    { defaultErrorMessage: "Failed to get task" },
  ),
);
