/**
 * Fetches unresolved bot review feedback from GitHub PRs.
 *
 * This module queries GitHub for review comments left by known bots
 * (Greptile, Devin, CodeRabbit, etc.) and filters to only unresolved ones.
 * The results are stored on the review record for display in the curation UI,
 * separate from the blind AI review.
 */

import { getOctokitForApp, parseRepoFullName } from "@/lib/github";

// ---------------------------------------------------------------------------
// Known bot authors
// ---------------------------------------------------------------------------

const BOT_AUTHORS = new Set([
  "greptile-apps",
  "greptile-apps[bot]",
  "devin-ai-integration[bot]",
  "devin-ai",
  "enzo-master-splinter",
  "enzo-master-splinter[bot]",
  "coderabbitai",
  "coderabbitai[bot]",
  "github-actions[bot]",
  "terragon-labs",
  "terragon-labs[bot]",
]);

function isBotAuthor(login: string): boolean {
  return BOT_AUTHORS.has(login.toLowerCase());
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewBotFeedback {
  /** GitHub comment ID */
  id: number;
  /** Bot username that left the comment */
  author: string;
  /** File path the comment is on, or null for top-level review comments */
  file: string | null;
  /** Line number the comment refers to, or null */
  line: number | null;
  /** Comment body text */
  body: string;
  /** ISO timestamp of when the comment was created */
  createdAt: string;
  /** Whether this is a review-level comment vs inline */
  isReviewComment: boolean;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Fetch unresolved bot feedback for a PR.
 *
 * This collects:
 * 1. Inline review comments (pulls.listReviewComments) from bot authors
 * 2. Top-level review body comments (pulls.listReviews) from bot authors
 *
 * "Unresolved" is approximated by including all bot comments that haven't been
 * explicitly resolved via GitHub's conversation resolution. GitHub doesn't expose
 * thread resolution status via REST API for inline comments, so we include all
 * bot comments and let the caller decide on display filtering.
 */
export async function fetchUnresolvedBotFeedback({
  repoFullName,
  prNumber,
}: {
  repoFullName: string;
  prNumber: number;
}): Promise<ReviewBotFeedback[]> {
  const [owner, repo] = parseRepoFullName(repoFullName);
  const octokit = await getOctokitForApp({ owner, repo });

  const feedback: ReviewBotFeedback[] = [];

  // Fetch inline review comments (file-level comments)
  const [reviewCommentsResponse, reviewsResponse] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);

  // Process inline review comments
  for (const comment of reviewCommentsResponse) {
    const login = comment.user?.login;
    if (!login || !isBotAuthor(login)) continue;

    feedback.push({
      id: comment.id,
      author: login,
      file: comment.path ?? null,
      line: comment.line ?? comment.original_line ?? null,
      body: comment.body ?? "",
      createdAt: comment.created_at,
      isReviewComment: false,
    });
  }

  // Process top-level review comments (the review body itself)
  for (const review of reviewsResponse) {
    const login = review.user?.login;
    if (!login || !isBotAuthor(login)) continue;

    // Only include reviews that have a body (skip empty approvals)
    if (!review.body || review.body.trim().length === 0) continue;

    feedback.push({
      id: review.id,
      author: login,
      file: null,
      line: null,
      body: review.body,
      createdAt: review.submitted_at ?? new Date().toISOString(),
      isReviewComment: true,
    });
  }

  // Sort by creation time, oldest first
  feedback.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return feedback;
}
