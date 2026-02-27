import { env } from "@terragon/env/apps-www";
import { Octokit } from "octokit";
import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { getOctokitForApp } from "@/lib/github";
import { formatThreadContext } from "@/server-lib/ext-thread-context";
import { publicAppUrl } from "@terragon/env/next-public";
import { db } from "@/lib/db";
import { getUserIdByGitHubAccountId } from "@terragon/shared/model/user";
import { AIModel } from "@terragon/agent/types";
import { parseModelOrNull } from "@terragon/agent/utils";

// Check if comment mentions the GitHub app
export function isAppMentioned(commentBody: string): boolean {
  const githubAppName = env.NEXT_PUBLIC_GITHUB_APP_NAME;
  if (!githubAppName) {
    return false;
  }
  // Look for @app-name mentions in the comment
  const mentionPattern = new RegExp(`@${githubAppName}\\b`, "i");
  return mentionPattern.test(commentBody);
}

/**
 * Extract model name from GitHub comment body.
 * Looks for patterns like "@terragon-labs [sonnet]" or "@terragon-labs [opus]"
 * Returns the model name if valid, null otherwise.
 *
 * Examples:
 * - "@terragon-labs [sonnet] fix this bug" -> "sonnet"
 * - "@terragon-labs [gpt-5] improve code" -> "gpt-5"
 * - "@terragon-labs fix this" -> null
 * - "@terragon-labs [invalid-model]" -> null
 */
export function extractModelFromComment({
  commentBody,
}: {
  commentBody: string;
}): AIModel | null {
  const githubAppName = env.NEXT_PUBLIC_GITHUB_APP_NAME;
  if (!githubAppName) {
    return null;
  }
  // Pattern: @app-name [model-name]
  // Matches @app-name followed by optional whitespace, then [model-name]
  const pattern = new RegExp(`@${githubAppName}\\s*\\[([^\\]]+)\\]`, "i");
  const match = commentBody.match(pattern);
  if (!match || !match[1]) {
    return null;
  }
  const modelName = match[1].trim();
  return parseModelOrNull({ modelName });
}
export async function isKnownGitHubAccount({
  gitHubAccountId,
}: {
  gitHubAccountId: number | undefined;
}): Promise<boolean> {
  if (!gitHubAccountId) {
    return false;
  }
  try {
    const userId = await getUserIdByGitHubAccountId({
      db,
      accountId: gitHubAccountId.toString(),
    });
    return !!userId;
  } catch (e) {
    console.error("Error checking account access for GitHub comment user:", e);
    return false;
  }
}

// Post a standardized Terragon configuration comment. If a review comment id is provided,
// reply in-thread; otherwise post a top-level issue/PR comment.
export async function postIntegrationSetupComment({
  octokit,
  owner,
  repo,
  issueNumber,
  reviewCommentId,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  issueNumber: number; // PR number or issue number
  reviewCommentId?: number;
}): Promise<void> {
  const settingsUrl = `${publicAppUrl()}/settings`;
  const body = `To use Terragon from GitHub, please visit the settings page and ensure your account is connected: ${settingsUrl}`;

  if (reviewCommentId) {
    try {
      await octokit.rest.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: issueNumber,
        comment_id: reviewCommentId,
        body,
      });
      return;
    } catch (err) {
      console.error(
        "Failed to reply with integration setup comment; falling back to PR comment:",
        err,
      );
      // Fall back to a top-level PR comment
    }
  }

  try {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  } catch (err) {
    console.error("Failed to post integration setup comment:", err);
  }
}

// Add eyes emoji reaction to a comment
// Note: GitHub has two different comment types for PRs:
// - "issue_comment": Regular PR comments (Conversation tab) and issue comments - use createForIssueComment
// - "review_comment": PR review comments (Files Changed tab) - use createForPullRequestReviewComment
// This distinction is important because the APIs are different, even though both appear on PRs
export async function addEyesReactionToComment({
  octokit,
  owner,
  repo,
  commentId,
  commentType,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  commentId: number;
  commentType: "issue_comment" | "review_comment";
}): Promise<void> {
  try {
    if (commentType === "issue_comment") {
      await octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: commentId,
        content: "eyes",
      });
    } else {
      await octokit.rest.reactions.createForPullRequestReviewComment({
        owner,
        repo,
        comment_id: commentId,
        content: "eyes",
      });
    }
    console.log(`Added eyes reaction to comment ${commentId}`);
  } catch (error) {
    // If reaction already exists, that's fine
    if (error instanceof Error && error.message.includes("already exists")) {
      console.log(`Eyes reaction already exists on comment ${commentId}`);
    } else {
      console.error(
        `Failed to add eyes reaction to comment ${commentId}:`,
        error,
      );
    }
  }
}

// Add eyes emoji reaction to a pull request
export async function addEyesReactionToPullRequest({
  owner,
  repo,
  issueNumber,
}: {
  owner: string;
  repo: string;
  issueNumber: number;
}): Promise<void> {
  const repoFullName = `${owner}/${repo}`;
  try {
    const octokit = await getOctokitForApp({ owner, repo });
    await octokit.rest.reactions.createForIssue({
      owner,
      repo,
      issue_number: issueNumber,
      content: "eyes",
    });
    console.log(`Added eyes reaction to PR #${issueNumber} in ${repoFullName}`);
  } catch (error) {
    // If reaction already exists, that's fine
    if (error instanceof Error && error.message.includes("already exists")) {
      console.log(
        `Eyes reaction already exists on PR #${issueNumber} in ${repoFullName}`,
      );
    } else {
      console.error(
        `Failed to add eyes reaction to PR #${issueNumber} in ${repoFullName}:`,
        error,
      );
    }
  }
}

// Fetch full comment thread context for PR comments
export async function fetchCommentThreadContext({
  octokit,
  owner,
  repo,
  issueNumber,
  currentCommentId,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  issueNumber: number;
  currentCommentId: number;
}): Promise<string | undefined> {
  try {
    // Fetch all comments on the issue/PR
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100, // GitHub max is 100
    });

    // Find the current comment and build context
    const currentCommentIndex = comments.findIndex(
      (c) => c.id === currentCommentId,
    );

    if (currentCommentIndex === -1) {
      return undefined;
    }

    // Include up to 5 previous comments for context
    const startIndex = Math.max(0, currentCommentIndex - 5);
    const relevantComments = comments.slice(
      startIndex,
      currentCommentIndex + 1,
    );

    const entries = relevantComments
      .filter((comment) => {
        return comment.id !== currentCommentId && comment.body?.trim();
      })
      .map((comment) => {
        const username = comment.user?.login || "unknown";
        return {
          author: username,
          body: (comment.body as string).trim(),
        };
      });

    if (entries.length === 0) {
      return undefined;
    }

    return formatThreadContext(entries);
  } catch (error) {
    console.error("Error fetching comment thread context:", error);
    return undefined;
  }
}

// Fetch review comment thread context for PR review comments
export async function fetchReviewCommentThreadContext({
  octokit,
  owner,
  repo,
  prNumber,
  currentCommentId,
  inReplyToId,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  currentCommentId: number;
  inReplyToId: number;
}): Promise<string | undefined> {
  try {
    // Fetch all review comments on the PR
    const { data: comments } = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100, // GitHub max is 100
    });

    const commentMap = new Map<number, PRReviewComment>();
    for (const comment of comments) {
      commentMap.set(comment.id, comment as PRReviewComment);
    }

    // Find the root of the thread
    const findRoot = (commentId: number): number => {
      const comment = commentMap.get(commentId);
      if (!comment || !comment.in_reply_to_id) {
        return commentId;
      }
      return findRoot(comment.in_reply_to_id);
    };
    const rootId = findRoot(inReplyToId) || findRoot(currentCommentId);
    // Get all comments in the same thread
    const threadComments = comments.filter(
      (c) => c.id === rootId || findRoot(c.id) === rootId,
    );
    // Sort by creation time
    threadComments.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    const entries = threadComments
      .filter((comment) => comment.id !== currentCommentId)
      .filter((comment) => (comment.body || "").trim() !== "")
      .map((comment) => ({
        author: comment.user?.login || "unknown",
        body: comment.body as string,
      }));

    if (entries.length === 0) {
      return undefined;
    }

    return formatThreadContext(entries);
  } catch (error) {
    console.error("Error fetching review comment thread context:", error);
    return undefined;
  }
}

// Type for PR review comment from webhook event
export type PRReviewComment =
  EmitterWebhookEvent<"pull_request_review_comment">["payload"]["comment"];

// Extract diff context from PR review comment
export function getDiffContextStr(comment: PRReviewComment): string {
  try {
    const sections: string[] = [];
    // Line and position information
    if (
      comment.line != null ||
      comment.start_line != null ||
      comment.position != null
    ) {
      const parts: string[] = [];
      parts.push(`// Side: ${comment.side === "LEFT" ? "base" : "head"}`);
      if (comment.start_line != null && comment.start_line !== comment.line) {
        parts.push(`Start line: ${comment.start_line}`);
        parts.push(`End line: ${comment.line}`);
      } else {
        parts.push(`Line: ${comment.line}`);
      }
      if (parts.length > 0) {
        sections.push(`${parts.join(", ")}`);
      }
    }
    // Metadata (only for reply info and original line if outdated)
    const metadata: string[] = [];
    if (comment.in_reply_to_id) {
      metadata.push(`Comment id: ${comment.id}`);
    }
    if (
      comment.original_commit_id &&
      comment.original_commit_id !== comment.commit_id &&
      comment.original_line != null
    ) {
      metadata.push(`Originally at line ${comment.original_line}`);
    }
    if (metadata.length > 0) {
      sections.push(metadata.join(" | "));
    }

    const diffParts: string[] = [];
    // Standard git diff header format
    if (comment.path) {
      diffParts.push(`diff --git a/${comment.path} b/${comment.path}`);

      // Add index line with commit SHAs if available
      if (
        comment.original_commit_id &&
        comment.commit_id &&
        comment.original_commit_id !== comment.commit_id
      ) {
        diffParts.push(
          `index ${comment.original_commit_id.substring(0, 7)}..${comment.commit_id.substring(0, 7)}`,
        );
      } else if (comment.commit_id) {
        diffParts.push(`index ${comment.commit_id.substring(0, 7)}`);
      }

      diffParts.push(`--- a/${comment.path}`);
      diffParts.push(`+++ b/${comment.path}`);
    }
    // Diff hunk
    if (comment.diff_hunk) {
      if (diffParts.length > 0) {
        diffParts.push("");
      }
      diffParts.push(comment.diff_hunk.trim());
    }
    if (diffParts.length > 0) {
      sections.push("```diff");
      sections.push(diffParts.join("\n"));
      sections.push("```");
    }
    return sections.join("\n");
  } catch (error) {
    console.error("Error getting diff context:", error);
    return "";
  }
}
