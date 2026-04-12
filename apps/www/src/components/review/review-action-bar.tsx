"use client";

import { useCallback, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  CheckIcon,
  MessageSquareWarningIcon,
  XIcon,
  RefreshCwIcon,
} from "lucide-react";
import { submitReviewDecision } from "@/server-actions/review-detail";
import type { ReviewPhase } from "@/types/review";

interface ReviewActionBarProps {
  reviewId: string;
  phase: ReviewPhase;
}

export function ReviewActionBar({ reviewId, phase }: ReviewActionBarProps) {
  const [isPending, startTransition] = useTransition();

  const handleDecision = useCallback(
    (decision: "approved" | "changes_requested" | "done") => {
      startTransition(async () => {
        await submitReviewDecision(reviewId, decision);
      });
    },
    [reviewId],
  );

  const showReReview = phase === "await_author_fixes";

  return (
    <div className="flex items-center gap-2 border-t border-border/50 bg-card/80 backdrop-blur-sm p-4 sticky bottom-0">
      <Button
        variant="outline"
        size="sm"
        onClick={() => handleDecision("done")}
        disabled={isPending}
        className="text-muted-foreground"
      >
        <XIcon className="h-4 w-4" />
        Done
      </Button>

      <div className="flex-1" />

      {showReReview && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            // TODO: trigger re-review flow
          }}
          disabled={isPending}
        >
          <RefreshCwIcon className="h-4 w-4" />
          Re-Review
        </Button>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={() => handleDecision("changes_requested")}
        disabled={isPending}
        className="text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
      >
        <MessageSquareWarningIcon className="h-4 w-4" />
        Request Changes
      </Button>

      <Button
        size="sm"
        onClick={() => handleDecision("approved")}
        disabled={isPending}
        className="bg-emerald-600 text-white hover:bg-emerald-500"
      >
        <CheckIcon className="h-4 w-4" />
        Approve
      </Button>
    </div>
  );
}
