"use server";

import { adminOnly } from "@/lib/auth-server";
import { updateGitHubPR, getOctokitForApp } from "@/lib/github";
import { User } from "@leo/shared";

export const refreshGitHubPR = adminOnly(async function refreshGitHubPR(
  adminUser: User,
  {
    prNumber,
    repoFullName,
  }: {
    prNumber: number;
    repoFullName: string;
  },
) {
  await updateGitHubPR({ repoFullName, prNumber, createIfNotFound: false });
});

export const postGitHubCommentForTesting = adminOnly(
  async function postGitHubCommentForTesting(
    adminUser: User,
    {
      owner,
      repo,
      issueOrPRNumber,
      issueOrPRType,
      comment,
    }: {
      owner: string;
      repo: string;
      issueOrPRNumber: number;
      issueOrPRType: "issue" | "pr";
      comment: string;
    },
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    console.log("postGitHubCommentForTesting", {
      owner,
      repo,
      issueOrPRNumber,
      issueOrPRType,
      comment,
    });
    try {
      const octokit = await getOctokitForApp({ owner, repo });
      const response = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueOrPRNumber,
        body: comment,
      });
      return {
        success: true,
        message: JSON.stringify(
          {
            id: response.data.id,
            html_url: response.data.html_url,
            created_at: response.data.created_at,
            user: response.data.user?.login,
            body: response.data.body,
          },
          null,
          2,
        ),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
);
