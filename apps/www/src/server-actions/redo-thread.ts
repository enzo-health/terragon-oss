"use server";

import { db } from "@/lib/db";
import { userOnlyAction } from "@/lib/auth-server";
import { DBUserMessage } from "@leo/shared";
import { getThreadMinimal } from "@leo/shared/model/threads";
import { newThread } from "./new-thread";
import { archiveThread } from "./archive-thread";
import { getPostHogServer } from "@/lib/posthog-server";
import { unwrapResult, UserFacingError } from "@/lib/server-actions";

export const redoThread = userOnlyAction(
  async function redoThread(
    userId: string,
    {
      threadId,
      userMessage,
      repoFullName,
      branchName,
      disableGitCheckpointing,
      skipSetup,
      skipArchiving,
    }: {
      threadId: string;
      userMessage: DBUserMessage;
      repoFullName: string;
      branchName: string;
      disableGitCheckpointing?: boolean;
      skipSetup?: boolean;
      skipArchiving?: boolean;
    },
  ) {
    console.log("redoThread", threadId);
    const thread = await getThreadMinimal({ db, threadId, userId });
    if (!thread) {
      throw new UserFacingError("Task not found");
    }
    getPostHogServer().capture({
      distinctId: userId,
      event: "redo_thread",
      properties: {
        threadId,
        skipSetup,
        skipArchiving,
        disableGitCheckpointing,
        repoFullName,
        branchName,
      },
    });
    unwrapResult(
      await newThread({
        message: userMessage,
        githubRepoFullName: repoFullName,
        branchName,
        parentThreadId: thread.id,
        disableGitCheckpointing,
        skipSetup,
        sourceType: "www-redo",
      }),
    );
    if (!skipArchiving) {
      const archiveThreadResult = await archiveThread(threadId);
      // Don't throw if the archive thread fails
      if (!archiveThreadResult.success) {
        console.error(
          "Failed to archive thread",
          archiveThreadResult.errorMessage,
        );
      }
    }
  },
  { defaultErrorMessage: "Failed to redo task" },
);
