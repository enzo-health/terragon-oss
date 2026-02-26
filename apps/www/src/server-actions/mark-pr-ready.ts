"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { getThreadMinimal } from "@terragon/shared/model/threads";
import { db } from "@/lib/db";
import {
  getOctokitForUserOrThrow,
  parseRepoFullName,
  updateGitHubPR,
} from "@/lib/github";
import { getPostHogServer } from "@/lib/posthog-server";
import { UserFacingError } from "@/lib/server-actions";
import { markPullRequestReadyForReview } from "@/server-lib/github-pr";
import {
  convertToDraftOnceForUiGuard,
  withUiReadyGuard,
} from "@/server-lib/preview-validation";

export const markPRReadyForReview = userOnlyAction(
  async function markPRReadyForReview(
    userId: string,
    {
      threadId,
    }: {
      threadId: string;
    },
  ) {
    console.log("markPRReadyForReview", threadId);
    const thread = await getThreadMinimal({ db, threadId, userId });
    if (!thread) {
      throw new UserFacingError("Task not found");
    }
    if (thread.githubPRNumber == null) {
      throw new UserFacingError("Task has no PR number");
    }
    const prNumber = thread.githubPRNumber;
    getPostHogServer().capture({
      distinctId: userId,
      event: "mark_pr_ready_for_review",
      properties: {
        threadId,
        githubRepoFullName: thread.githubRepoFullName,
        prNumber,
      },
    });
    const [owner, repo] = parseRepoFullName(thread.githubRepoFullName);
    const octokit = await getOctokitForUserOrThrow({ userId });
    // UI_READY_GUARD:markPRReadyForReview
    await withUiReadyGuard({
      entrypoint: "markPRReadyForReview",
      threadId,
      action: async () => {
        await markPullRequestReadyForReview({
          octokit,
          owner,
          repo,
          prNumber,
        });
        await updateGitHubPR({
          repoFullName: thread.githubRepoFullName,
          prNumber,
          createIfNotFound: false,
        });
        console.log("Successfully marked PR as ready for review");
      },
      onBlocked: async (decision) => {
        if (decision.runId && decision.threadChatId) {
          await convertToDraftOnceForUiGuard({
            threadId,
            runId: decision.runId,
            threadChatId: decision.threadChatId,
            repoFullName: thread.githubRepoFullName,
            prNumber,
            octokit,
          });
        }
        throw new UserFacingError(
          decision.reason ??
            "UI validation has not passed yet, so this PR must stay in draft.",
        );
      },
    });
  },
  {
    defaultErrorMessage: "Failed to mark PR as ready for review",
  },
);
