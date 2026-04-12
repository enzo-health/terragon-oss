"use client";

import { ReviewPipelineTimeline } from "./review-pipeline-timeline";
import { ReviewPRContext } from "./review-pr-context";
import { ReviewCommentList } from "./review-comment-list";
import { ReviewActionBar } from "./review-action-bar";
import type { ReviewDetail } from "@/types/review";

interface ReviewDetailViewProps {
  review: ReviewDetail;
}

export function ReviewDetailView({ review }: ReviewDetailViewProps) {
  const maxRound = review.comments.reduce(
    (max, c) => Math.max(max, c.reviewRound),
    1,
  );
  const hasChangesRequested =
    review.assignment?.decision === "changes_requested";

  return (
    <div className="flex h-full w-full min-w-0">
      {/* Left: Pipeline Timeline Sidebar */}
      <div className="w-[200px] shrink-0 border-r border-border/50 overflow-y-auto">
        <ReviewPipelineTimeline
          phase={review.phase}
          reviewRound={maxRound}
          hasChangesRequested={hasChangesRequested}
        />
      </div>

      {/* Center: PR Context Section */}
      <div className="flex-1 min-w-0 overflow-y-auto border-r border-border/50">
        <ReviewPRContext review={review} />
      </div>

      {/* Right: Comment Curation Panel */}
      <div className="w-[420px] shrink-0 flex flex-col min-h-0">
        <ReviewCommentList review={review} />
        <ReviewActionBar reviewId={review.id} phase={review.phase} />
      </div>
    </div>
  );
}
