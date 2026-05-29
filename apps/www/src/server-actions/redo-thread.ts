"use server";

import { db } from "@/lib/db";
import { userOnlyAction } from "@/lib/auth-server";
import { DBUserMessage } from "@terragon/shared";
import { getThreadMinimal } from "@terragon/shared/model/threads";
import { newThread } from "./new-thread";
import { archiveThread } from "./archive-thread";
import { unwrapResult, requireResult } from "@/lib/server-actions";

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
    const thread = await requireResult(
      () => getThreadMinimal({ db, threadId, userId }),
      "Task not found",
    );
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
