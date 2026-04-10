/**
 * Auto-close/complete PR reviews when the underlying PR is merged or closed.
 *
 * This module provides the core logic for transitioning active reviews
 * to their terminal state. It is designed to be called from the GitHub
 * webhook handler when a pull_request.closed event fires.
 *
 * NOTE: This module defines the review lifecycle transitions but does not
 * yet have review tables in the DB schema. The types and SQL queries below
 * are placeholder-ready — once the review schema lands, swap the inline
 * types for the real Drizzle table references.
 */

// ---------------------------------------------------------------------------
// Types (will be replaced by Drizzle schema types when review tables land)
// ---------------------------------------------------------------------------

/**
 * Represents the phase of a PR review lifecycle.
 * Active phases: "pending", "in_progress", "awaiting_reviewer"
 * Terminal phases: "complete", "cancelled"
 */
export type ReviewPhase =
  | "pending"
  | "in_progress"
  | "awaiting_reviewer"
  | "complete"
  | "cancelled";

// Active (non-terminal) review phases — used in the WHERE clause of the
// Drizzle query once the review schema lands:
//   const ACTIVE_PHASES: ReviewPhase[] = ["pending", "in_progress", "awaiting_reviewer"];

// ---------------------------------------------------------------------------
// Core auto-close logic
// ---------------------------------------------------------------------------

/**
 * Transition all active reviews for a PR to their terminal state.
 *
 * - If the PR was merged: mark reviews as "complete"
 * - If the PR was closed without merge: mark reviews as "cancelled"
 *
 * This function is idempotent — calling it multiple times for the same
 * PR is safe (already-terminal reviews are skipped by the WHERE clause).
 *
 * @param repoFullName - Full repository name (e.g. "owner/repo")
 * @param prNumber - Pull request number
 * @param prState - Whether the PR was "merged" or "closed" (without merge)
 * @returns The number of reviews that were transitioned
 */
export async function autoCompleteReviewsForPR({
  repoFullName,
  prNumber,
  prState,
}: {
  repoFullName: string;
  prNumber: number;
  prState: "merged" | "closed";
}): Promise<{ updatedCount: number }> {
  const targetPhase: ReviewPhase =
    prState === "merged" ? "complete" : "cancelled";

  console.log(
    `[review-auto-close] Transitioning active reviews for ${repoFullName}#${prNumber} to "${targetPhase}"`,
  );

  // NOTE: Once the review schema is created, replace this with a real Drizzle
  // query. The intended query shape:
  //
  //   const result = await db
  //     .update(schema.review)
  //     .set({
  //       phase: targetPhase,
  //       completedAt: new Date(),
  //       updatedAt: new Date(),
  //     })
  //     .where(
  //       and(
  //         eq(schema.review.repoFullName, repoFullName),
  //         eq(schema.review.prNumber, prNumber),
  //         inArray(schema.review.phase, ACTIVE_PHASES),
  //       ),
  //     )
  //     .returning({ id: schema.review.id });
  //
  //   // Dismiss pending assignments for transitioned reviews
  //   if (result.length > 0) {
  //     await db
  //       .update(schema.reviewAssignment)
  //       .set({ dismissedAt: new Date() })
  //       .where(
  //         and(
  //           inArray(
  //             schema.reviewAssignment.reviewId,
  //             result.map((r) => r.id),
  //           ),
  //           isNull(schema.reviewAssignment.completedAt),
  //           isNull(schema.reviewAssignment.dismissedAt),
  //         ),
  //       );
  //   }
  //
  //   return { updatedCount: result.length };

  // Placeholder: return 0 until the review schema is available.
  // The function signature and logging are ready for integration.
  console.log(
    `[review-auto-close] Review schema not yet available — skipping DB update for ${repoFullName}#${prNumber}`,
  );
  return { updatedCount: 0 };
}
