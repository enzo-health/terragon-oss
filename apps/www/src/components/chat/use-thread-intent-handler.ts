"use client";
import type { ThreadErrorMessage } from "@terragon/shared";
import {
  ThreadIntent,
  ThreadIntentSubscriber,
} from "@/hooks/use-thread-intent";
import { followUp, queueFollowUp } from "@/server-actions/follow-up";
import { stopThread } from "@/server-actions/stop-thread";
import { openPullRequest } from "@/server-actions/pull-request";
import { fixGithubChecks } from "@/server-actions/fix-github-checks";
import { markPRReadyForReview } from "@/server-actions/mark-pr-ready";
import {
  archiveThread,
  unarchiveThread,
} from "@/server-actions/archive-thread";
import { redoThread } from "@/server-actions/redo-thread";
import { forkThread } from "@/server-actions/fork-thread";
import { getThreadPageDiffAction } from "@/server-actions/get-thread-page-diff";
import { copyTextToClipboard } from "@/lib/clipboard";

type HandlerMap = {
  [K in ThreadIntent["type"]]: (
    intent: Extract<ThreadIntent, { type: K }>,
  ) => Promise<unknown>;
};

export function useCreateThreadIntentSubscriber({
  setError,
  refetch,
}: {
  setError: (error: ThreadErrorMessage | null) => void;
  refetch: () => Promise<unknown>;
}): ThreadIntentSubscriber {
  return async (intent: ThreadIntent) => {
    const handlers: HandlerMap = {
      "send-message": async (i) => {
        const result = await followUp({
          threadId: i.threadId,
          threadChatId: i.threadChatId,
          message: i.message,
          clientSubmissionId: i.clientSubmissionId ?? null,
        });
        if (!result.success) {
          setError(result.errorMessage);
          await refetch();
          throw new Error(result.errorMessage ?? "Failed to submit message");
        }
      },
      "queue-message": async (i) => {
        const result = await queueFollowUp({
          threadId: i.threadId,
          threadChatId: i.threadChatId,
          messages: i.messages,
        });
        if (!result.success) {
          setError(result.errorMessage);
          await refetch();
          throw new Error(result.errorMessage ?? "Failed to queue message");
        }
      },
      "stop-thread": async (i) => {
        const result = await stopThread({
          threadId: i.threadId,
          threadChatId: i.threadChatId,
        });
        if (!result.success) {
          setError(result.errorMessage);
          await refetch();
          throw new Error(result.errorMessage ?? "Failed to stop task");
        }
        await refetch();
      },
      "fix-checks": async (i) => {
        const result = await fixGithubChecks({
          threadId: i.threadId,
          threadChatId: i.threadChatId,
        });
        if (!result.success) {
          setError(result.errorMessage);
          throw new Error(result.errorMessage ?? "Failed to fix checks");
        }
      },
      "open-pr": async (i) => {
        const result = await openPullRequest({
          threadId: i.threadId,
          prType: i.prType ?? "draft",
        });
        if (!result.success) {
          throw new Error(result.errorMessage ?? "Failed to open PR");
        }
      },
      "mark-pr-ready": async (i) => {
        const result = await markPRReadyForReview({
          threadId: i.threadId,
        });
        if (!result.success) {
          throw new Error(result.errorMessage ?? "Failed to mark PR ready");
        }
      },
      "archive-thread": async (i) => {
        const result = i.archive
          ? await archiveThread(i.threadId)
          : await unarchiveThread(i.threadId);
        if (!result.success) {
          throw new Error(result.errorMessage ?? "Failed to archive task");
        }
      },
      "redo-task": async (i) => {
        const result = await redoThread({
          threadId: i.threadId,
          userMessage: i.userMessage,
          repoFullName: i.repoFullName,
          branchName: i.branchName,
          disableGitCheckpointing: i.disableGitCheckpointing,
          skipSetup: i.skipSetup,
          skipArchiving: i.skipArchiving,
        });
        if (!result.success) {
          throw new Error(result.errorMessage ?? "Failed to redo task");
        }
      },
      "fork-task": async (i) => {
        const result = await forkThread({
          threadId: i.threadId,
          threadChatId: i.threadChatId,
          userMessage: i.userMessage,
          repoFullName: i.repoFullName,
          branchName: i.branchName,
          disableGitCheckpointing: i.disableGitCheckpointing,
          skipSetup: i.skipSetup,
          createNewBranch: i.createNewBranch,
        });
        if (!result.success) {
          throw new Error(result.errorMessage ?? "Failed to fork task");
        }
      },
      "copy-git-diff": async (i) => {
        const result = await getThreadPageDiffAction(i.threadId);
        if (!result.success || !result.data) {
          throw new Error("Failed to get diff");
        }
        const gitDiff = result.data.gitDiff;
        if (!gitDiff || gitDiff === "too-large") {
          throw new Error("No changes to copy");
        }
        const patchCommand = `git apply - <<'PATCH'\n${gitDiff}\nPATCH`;
        await copyTextToClipboard(patchCommand);
      },
    };

    const handler = handlers[intent.type];
    await (handler as (intent: ThreadIntent) => Promise<unknown>)(intent);
  };
}
