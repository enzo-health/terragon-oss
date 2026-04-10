"use server";

import { userOnlyAction } from "@/lib/auth-server";
import type { ReviewDetail, ReviewCommentPriority } from "@/types/review";

export const getReviewDetail = userOnlyAction(
  async function getReviewDetail(
    _userId: string,
    _reviewId: string,
  ): Promise<ReviewDetail | null> {
    // TODO: query review + comments + assignment for this user
    return null;
  },
  { defaultErrorMessage: "Failed to load review detail" },
);

export const toggleCommentInclusion = userOnlyAction(
  async function toggleCommentInclusion(
    _userId: string,
    _commentId: string,
  ): Promise<void> {
    // TODO: toggle reviewComment.included
  },
  { defaultErrorMessage: "Failed to toggle comment inclusion" },
);

export const cycleCommentPriority = userOnlyAction(
  async function cycleCommentPriority(
    _userId: string,
    _commentId: string,
  ): Promise<void> {
    // TODO: cycle high -> medium -> low -> high
  },
  { defaultErrorMessage: "Failed to cycle comment priority" },
);

export const updateCommentBody = userOnlyAction(
  async function updateCommentBody(
    _userId: string,
    _commentId: string,
    _body: string,
  ): Promise<void> {
    // TODO: update reviewComment.body
  },
  { defaultErrorMessage: "Failed to update comment body" },
);

export const addHumanComment = userOnlyAction(
  async function addHumanComment(
    _userId: string,
    _reviewId: string,
    _data: {
      file: string;
      line?: number;
      priority: ReviewCommentPriority;
      body: string;
    },
  ): Promise<void> {
    // TODO: insert new reviewComment with authorUserId = user.id
  },
  { defaultErrorMessage: "Failed to add comment" },
);

export const submitReviewDecision = userOnlyAction(
  async function submitReviewDecision(
    _userId: string,
    _reviewId: string,
    _decision: "approved" | "changes_requested" | "done",
  ): Promise<void> {
    // TODO: post to GitHub, update assignment
  },
  { defaultErrorMessage: "Failed to submit review decision" },
);
