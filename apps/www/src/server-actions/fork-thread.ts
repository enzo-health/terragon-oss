"use server";

import { db } from "@/lib/db";
import { userOnlyAction } from "@/lib/auth-server";
import { DBUserMessage } from "@terragon/shared";
import { getThreadMinimal } from "@terragon/shared/model/threads";
import { createNewThread } from "../server-lib/new-thread-shared";
import { getPostHogServer } from "@/lib/posthog-server";
import { UserFacingError } from "@/lib/server-actions";

export const forkThread = userOnlyAction(
  async function forkThread(
    userId: string,
    {
      threadId,
      threadChatId,
      userMessage,
      repoFullName,
      branchName,
      disableGitCheckpointing,
      skipSetup,
      createNewBranch = true,
    }: {
      threadId: string;
      threadChatId: string;
      userMessage: DBUserMessage;
      repoFullName: string;
      branchName: string;
      disableGitCheckpointing?: boolean;
      skipSetup?: boolean;
      createNewBranch?: boolean;
    },
  ) {
    console.log("forkThread", { threadId, threadChatId });
    const thread = await getThreadMinimal({ db, threadId, userId });
    if (!thread) {
      throw new UserFacingError("Task not found");
    }

    getPostHogServer().capture({
      distinctId: userId,
      event: "fork_thread",
      properties: {
        threadId,
        threadChatId,
        skipSetup,
        disableGitCheckpointing,
        repoFullName,
        branchName,
        createNewBranch,
      },
    });

    let baseBranchName = branchName;
    let headBranchName: string | null = null;
    // If we're not creating a new branch, use the existing branch name
    // and set the base branch to the existing task's base branch.
    if (!createNewBranch) {
      baseBranchName = thread.repoBaseBranchName;
      headBranchName = branchName;
    }
    await createNewThread({
      userId,
      message: userMessage,
      githubRepoFullName: repoFullName,
      baseBranchName,
      headBranchName,
      parentThreadId: threadId,
      disableGitCheckpointing,
      skipSetup,
      sourceType: "www-fork",
      sourceMetadata: {
        type: "www-fork",
        parentThreadId: threadId,
        parentThreadChatId: threadChatId,
      },
    });
  },
  { defaultErrorMessage: "Failed to create task" },
);
