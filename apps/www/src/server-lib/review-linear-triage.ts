/**
 * Linear triage ticket creation for PR reviews.
 *
 * Creates Linear issues for individual review comments or bulk pre-existing
 * issues. Uses the workspace-level Linear installation token (app-actor OAuth)
 * via refreshLinearTokenIfNeeded.
 */

import { LinearClient } from "@linear/sdk";
import { db } from "@/lib/db";
import { refreshLinearTokenIfNeeded } from "@/server-lib/linear-oauth";
import { getLinearAccounts } from "@terragon/shared/model/linear";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewCommentPriority = "high" | "medium" | "low";

interface TriageComment {
  id?: string;
  file: string;
  line: number | null;
  priority: ReviewCommentPriority;
  body: string;
}

interface ReviewContext {
  id?: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  repoFullName: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map review priority to Linear issue priority (1=Urgent, 2=High, 3=Normal). */
function mapPriorityToLinear(priority: ReviewCommentPriority): number {
  switch (priority) {
    case "high":
      return 1; // Urgent
    case "medium":
      return 2; // High
    case "low":
      return 3; // Normal
  }
}

/** Return the highest (most urgent) priority from a list of comments. */
function highestPriority(
  comments: Array<{ priority: ReviewCommentPriority }>,
): ReviewCommentPriority {
  if (comments.some((c) => c.priority === "high")) return "high";
  if (comments.some((c) => c.priority === "medium")) return "medium";
  return "low";
}

/** Truncate text to a maximum length, appending ellipsis if needed. */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "\u2026";
}

/**
 * Get a valid Linear access token for the user's linked organization.
 * The user must have a linked Linear account so we can resolve their org.
 */
async function getLinearAccessTokenForUser(
  userId: string,
): Promise<{ accessToken: string; organizationId: string }> {
  const accounts = await getLinearAccounts({ db, userId });
  if (accounts.length === 0) {
    throw new Error(
      "No Linear account linked. Please connect your Linear account in Settings.",
    );
  }
  // Use the first linked account's organization
  const account = accounts[0]!;
  const tokenResult = await refreshLinearTokenIfNeeded(
    account.organizationId,
    db,
  );
  if (tokenResult.status !== "ok") {
    throw new Error(
      "Linear installation token is unavailable. Please reinstall the Linear agent in Settings.",
    );
  }
  return {
    accessToken: tokenResult.accessToken,
    organizationId: account.organizationId,
  };
}

// ---------------------------------------------------------------------------
// Individual comment triage
// ---------------------------------------------------------------------------

export async function createTriageTicketForComment({
  comment,
  review,
  teamId,
  userId,
}: {
  comment: TriageComment;
  review: ReviewContext;
  teamId: string;
  userId: string;
}): Promise<{ ticketUrl: string }> {
  const { accessToken } = await getLinearAccessTokenForUser(userId);
  const client = new LinearClient({ accessToken });

  const lineRef = comment.line != null ? `:${comment.line}` : "";
  const title = truncate(
    `[PR Review] ${comment.file}${lineRef} \u2014 ${comment.body}`,
    200,
  );

  const descriptionParts = [
    `### PR Review Finding`,
    "",
    `**PR:** [#${review.prNumber} ${review.prTitle}](${review.prUrl})`,
    `**Repository:** ${review.repoFullName}`,
    `**File:** \`${comment.file}\`${comment.line != null ? ` (line ${comment.line})` : ""}`,
    `**Priority:** ${comment.priority.toUpperCase()}`,
    "",
    `---`,
    "",
    comment.body,
  ];

  const issuePayload = await client.createIssue({
    teamId,
    title,
    description: descriptionParts.join("\n"),
    priority: mapPriorityToLinear(comment.priority),
  });

  const issue = await issuePayload.issue;
  if (!issue) {
    throw new Error("Failed to create Linear issue");
  }

  const ticketUrl = issue.url;
  return { ticketUrl };
}

// ---------------------------------------------------------------------------
// Bulk triage (all pre-existing issues)
// ---------------------------------------------------------------------------

export async function createBulkTriageTicket({
  comments,
  review,
  teamId,
  userId,
}: {
  comments: Array<TriageComment>;
  review: ReviewContext;
  teamId: string;
  userId: string;
}): Promise<{ ticketUrl: string }> {
  if (comments.length === 0) {
    throw new Error("No comments provided for bulk triage");
  }

  const { accessToken } = await getLinearAccessTokenForUser(userId);
  const client = new LinearClient({ accessToken });

  const priority = highestPriority(comments);
  const title = `[PR Review] Pre-existing issues in PR #${review.prNumber}`;

  // Build a markdown table of all comments
  const tableHeader = `| File | Line | Priority | Finding |`;
  const tableSeparator = `| --- | --- | --- | --- |`;
  const tableRows = comments.map((c) => {
    const lineRef = c.line != null ? String(c.line) : "\u2014";
    const shortBody = truncate(c.body, 120);
    return `| \`${c.file}\` | ${lineRef} | ${c.priority.toUpperCase()} | ${shortBody} |`;
  });

  const descriptionParts = [
    `### Pre-existing Issues from PR Review`,
    "",
    `**PR:** [#${review.prNumber} ${review.prTitle}](${review.prUrl})`,
    `**Repository:** ${review.repoFullName}`,
    `**Total findings:** ${comments.length}`,
    "",
    `---`,
    "",
    tableHeader,
    tableSeparator,
    ...tableRows,
  ];

  const issuePayload = await client.createIssue({
    teamId,
    title,
    description: descriptionParts.join("\n"),
    priority: mapPriorityToLinear(priority),
  });

  const issue = await issuePayload.issue;
  if (!issue) {
    throw new Error("Failed to create Linear issue");
  }

  const ticketUrl = issue.url;
  return { ticketUrl };
}
