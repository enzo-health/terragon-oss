"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { getThreadMinimal } from "@leo/shared/model/threads";
import { db } from "@/lib/db";
import {
  getOctokitForUserOrThrow,
  parseRepoFullName,
  updateGitHubPR,
} from "@/lib/github";
import { getPostHogServer } from "@/lib/posthog-server";
import { UserFacingError } from "@/lib/server-actions";

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
    if (!thread.githubPRNumber) {
      throw new UserFacingError("Task has no PR number");
    }
    getPostHogServer().capture({
      distinctId: userId,
      event: "mark_pr_ready_for_review",
      properties: {
        threadId,
        githubRepoFullName: thread.githubRepoFullName,
        prNumber: thread.githubPRNumber,
      },
    });
    const [owner, repo] = parseRepoFullName(thread.githubRepoFullName);
    const octokit = await getOctokitForUserOrThrow({ userId });

    // First, get the PR's node ID using REST API
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: thread.githubPRNumber,
    });

    // Use GraphQL to mark the PR as ready for review
    await octokit.graphql(
      `mutation ($pullRequestId: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
          pullRequest {
            id
            isDraft
          }
        }
      }`,
      {
        pullRequestId: pr.node_id,
      },
    );
    // Update the PR status in our database
    await updateGitHubPR({
      repoFullName: thread.githubRepoFullName,
      prNumber: thread.githubPRNumber,
      createIfNotFound: false,
    });
    console.log("Successfully marked PR as ready for review");
  },
  {
    defaultErrorMessage: "Failed to mark PR as ready for review",
  },
);
