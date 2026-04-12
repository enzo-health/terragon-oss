"use server";

import { userOnlyAction } from "@/lib/auth-server";
import type { ReviewForDashboard } from "@/types/review";

/**
 * Fetch all reviews assigned to the current user, ordered by most recently
 * updated first.
 *
 * TODO: Replace with actual DB query when the review schema branch is merged.
 * Query shape:
 *   SELECT review.*, reviewAssignment.decision AS assignmentDecision
 *     FROM review
 *     JOIN reviewAssignment ON review.id = reviewAssignment.reviewId
 *    WHERE reviewAssignment.userId = :userId
 *    ORDER BY review.updatedAt DESC
 */
export const getReviews = userOnlyAction(
  async function getReviews(_userId: string): Promise<ReviewForDashboard[]> {
    // Stub: return empty list until the schema is available
    return [] as ReviewForDashboard[];
  },
  { defaultErrorMessage: "Failed to load reviews" },
);
