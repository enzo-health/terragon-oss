"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import { getOctokitForUserOrThrow, parseRepoFullName } from "@/lib/github";
import * as reviewModel from "@terragon/shared/model/review";
import type {
  ReviewCommentPriority,
  ReviewDecision,
  Review,
  ReviewComment,
} from "@terragon/shared/db/types";

// ── Dashboard ────────────────────────────────────────────────────────

export const getReviewsAction = userOnlyAction(
  async function getReviewsAction(userId: string) {
    return await reviewModel.getReviewsForUser({ db, userId });
  },
  { defaultErrorMessage: "Failed to load reviews" },
);

// ── Detail ───────────────────────────────────────────────────────────

export const getReviewDetailAction = userOnlyAction(
  async function getReviewDetailAction(userId: string, reviewId: string) {
    const review = await reviewModel.getReview({ db, reviewId });
    if (!review) {
      throw new UserFacingError("Review not found");
    }

    // Verify the user has an assignment for this review
    const assignment = await reviewModel.getReviewAssignmentForUser({
      db,
      reviewId,
      userId,
    });
    if (!assignment) {
      throw new UserFacingError("You are not assigned to this review");
    }

    return review;
  },
  { defaultErrorMessage: "Failed to load review details" },
);

// ── Comment mutations ────────────────────────────────────────────────

export const toggleCommentInclusionAction = userOnlyAction(
  async function toggleCommentInclusionAction(
    _userId: string,
    commentId: string,
  ) {
    const comments = await db.query.reviewComment.findFirst({
      where: (t, { eq }) => eq(t.id, commentId),
    });
    if (!comments) {
      throw new UserFacingError("Comment not found");
    }
    return await reviewModel.updateReviewComment({
      db,
      commentId,
      data: { included: !comments.included },
    });
  },
  { defaultErrorMessage: "Failed to toggle comment inclusion" },
);

const PRIORITY_CYCLE: ReviewCommentPriority[] = ["high", "medium", "low"];

export const cycleCommentPriorityAction = userOnlyAction(
  async function cycleCommentPriorityAction(
    _userId: string,
    commentId: string,
  ) {
    const comment = await db.query.reviewComment.findFirst({
      where: (t, { eq }) => eq(t.id, commentId),
    });
    if (!comment) {
      throw new UserFacingError("Comment not found");
    }
    const currentIndex = PRIORITY_CYCLE.indexOf(
      comment.priority as ReviewCommentPriority,
    );
    const nextPriority =
      PRIORITY_CYCLE[(currentIndex + 1) % PRIORITY_CYCLE.length];
    return await reviewModel.updateReviewComment({
      db,
      commentId,
      data: { priority: nextPriority },
    });
  },
  { defaultErrorMessage: "Failed to cycle comment priority" },
);

export const updateCommentBodyAction = userOnlyAction(
  async function updateCommentBodyAction(
    _userId: string,
    commentId: string,
    body: string,
  ) {
    if (!body.trim()) {
      throw new UserFacingError("Comment body cannot be empty");
    }
    return await reviewModel.updateReviewComment({
      db,
      commentId,
      data: { body },
    });
  },
  { defaultErrorMessage: "Failed to update comment" },
);

export const addHumanCommentAction = userOnlyAction(
  async function addHumanCommentAction(
    userId: string,
    reviewId: string,
    data: {
      file: string;
      line?: number;
      priority: ReviewCommentPriority;
      body: string;
    },
  ) {
    // Verify user is assigned to the review
    const assignment = await reviewModel.getReviewAssignmentForUser({
      db,
      reviewId,
      userId,
    });
    if (!assignment) {
      throw new UserFacingError("You are not assigned to this review");
    }

    return await reviewModel.createReviewComment({
      db,
      data: {
        reviewId,
        authorUserId: userId,
        file: data.file,
        line: data.line,
        priority: data.priority,
        body: data.body,
        included: true,
        posted: false,
      },
    });
  },
  { defaultErrorMessage: "Failed to add comment" },
);

// ── Submit review decision ───────────────────────────────────────────

export const submitReviewDecisionAction = userOnlyAction(
  async function submitReviewDecisionAction(
    userId: string,
    reviewId: string,
    decision: "approved" | "changes_requested" | "done",
  ) {
    const review = await reviewModel.getReview({ db, reviewId });
    if (!review) {
      throw new UserFacingError("Review not found");
    }

    const assignment = await reviewModel.getReviewAssignmentForUser({
      db,
      reviewId,
      userId,
    });
    if (!assignment) {
      throw new UserFacingError("You are not assigned to this review");
    }

    // Map "done" to a DB decision — the user is simply marking it complete
    // without posting to GitHub.
    const dbDecision: ReviewDecision =
      decision === "done" ? "approved" : decision;

    if (decision === "approved" || decision === "changes_requested") {
      // Post to GitHub before updating the DB
      const comments = await reviewModel.getReviewComments({
        db,
        reviewId,
      });
      const includedComments = comments.filter((c) => c.included);

      await postReviewToGitHub({
        review,
        comments: includedComments,
        decision,
        userId,
      });

      // Mark posted comments
      const postedIds = includedComments.map((c) => c.id);
      await reviewModel.markReviewCommentsPosted({ db, commentIds: postedIds });
    }

    // Update the assignment
    await reviewModel.updateReviewAssignment({
      db,
      assignmentId: assignment.id,
      data: {
        decision: dbDecision,
        postedAt: decision !== "done" ? new Date() : undefined,
      },
    });

    // If all assignments are resolved, complete the review
    const allAssignments = await reviewModel.getReviewAssignmentsForReview({
      db,
      reviewId,
    });
    const allDecided = allAssignments.every(
      (a) => a.decision && a.decision !== "pending",
    );
    if (allDecided) {
      await reviewModel.completeReview({ db, reviewId });
    } else {
      // Move to await_author_fixes if someone requested changes
      const hasChangesRequested = allAssignments.some(
        (a) => a.decision === "changes_requested",
      );
      if (hasChangesRequested) {
        await reviewModel.updateReview({
          db,
          reviewId,
          data: { phase: "await_author_fixes" },
        });
      }
    }
  },
  { defaultErrorMessage: "Failed to submit review decision" },
);

// ── Refresh PR metadata ──────────────────────────────────────────────

export const refreshReviewMetadataAction = userOnlyAction(
  async function refreshReviewMetadataAction(userId: string, reviewId: string) {
    const review = await reviewModel.getReview({ db, reviewId });
    if (!review) {
      throw new UserFacingError("Review not found");
    }

    const [owner, repo] = parseRepoFullName(review.repoFullName);
    const octokit = await getOctokitForUserOrThrow({ userId });

    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: review.prNumber,
    });

    await reviewModel.updateReview({
      db,
      reviewId,
      data: {
        prTitle: pr.title,
        prState: pr.draft
          ? "draft"
          : pr.merged
            ? "merged"
            : pr.state === "closed"
              ? "closed"
              : "open",
        prBaseBranch: pr.base.ref,
        prHeadBranch: pr.head.ref,
        hasConflicts: pr.mergeable === false,
        diffStats: {
          files: pr.changed_files,
          additions: pr.additions,
          deletions: pr.deletions,
        },
      },
    });
  },
  { defaultErrorMessage: "Failed to refresh PR metadata" },
);

// ── GitHub posting helper ────────────────────────────────────────────

async function postReviewToGitHub({
  review,
  comments,
  decision,
  userId,
}: {
  review: Review;
  comments: ReviewComment[];
  decision: "approved" | "changes_requested";
  userId: string;
}) {
  const [owner, repo] = parseRepoFullName(review.repoFullName);
  const octokit = await getOctokitForUserOrThrow({ userId });

  // Build the review body
  const bodyParts: string[] = [];

  if (review.summary) {
    bodyParts.push(`## Summary\n${review.summary}`);
  }

  if (review.doneWell) {
    bodyParts.push(`## What was done well\n${review.doneWell}`);
  }

  if (review.triageTicketUrl) {
    bodyParts.push(`## Triage\n${review.triageTicketUrl}`);
  }

  // Action items table
  if (comments.length > 0) {
    const header = "| Priority | File | Comment |\n| --- | --- | --- |";
    const rows = comments.map(
      (c) =>
        `| ${c.priority} | \`${c.file}${c.line ? `:${c.line}` : ""}\` | ${c.body.replace(/\n/g, " ")} |`,
    );
    bodyParts.push(`## Review Comments\n${header}\n${rows.join("\n")}`);
  }

  const reviewBody = bodyParts.join("\n\n");
  const event = decision === "approved" ? "APPROVE" : "REQUEST_CHANGES";

  // Separate inline comments (with file+line) from general comments
  const inlineComments = comments.filter((c) => c.line != null);
  const generalComments = comments.filter((c) => c.line == null);

  // Post the PR review with inline comments
  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: review.prNumber,
      body: reviewBody,
      event,
      comments: inlineComments.map((c) => ({
        path: c.file,
        line: c.line!,
        body: `**[${c.priority.toUpperCase()}]** ${c.body}`,
      })),
    });
  } catch (error) {
    // If inline comments fail (e.g., lines not in diff), fall back to posting
    // review without inline comments and post them as issue comments instead.
    console.warn(
      "[review] Failed to post inline review comments, falling back to issue comments",
      error,
    );

    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: review.prNumber,
      body: reviewBody,
      event,
    });

    // Post inline comments as individual issue comments
    for (const c of inlineComments) {
      try {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: review.prNumber,
          body: `**[${c.priority.toUpperCase()}]** \`${c.file}:${c.line}\`\n\n${c.body}`,
        });
      } catch (commentError) {
        console.error(
          `[review] Failed to post fallback comment for ${c.file}:${c.line}`,
          commentError,
        );
      }
    }
  }

  // Post general comments (no line number) as issue comments
  for (const c of generalComments) {
    try {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: review.prNumber,
        body: `**[${c.priority.toUpperCase()}]** \`${c.file}\`\n\n${c.body}`,
      });
    } catch (commentError) {
      console.error(
        `[review] Failed to post general comment for ${c.file}`,
        commentError,
      );
    }
  }
}
