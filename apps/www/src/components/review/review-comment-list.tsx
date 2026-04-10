"use client";

import { useCallback, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDownIcon } from "lucide-react";
import { ReviewCommentItem } from "./review-comment-item";
import { ReviewAddCommentForm } from "./review-add-comment-form";
import type {
  ReviewCommentDetail,
  ReviewCommentPriority,
  ReviewDetail,
  ReviewRiskLevel,
} from "@/types/review";

const PRIORITY_ORDER: ReviewCommentPriority[] = ["high", "medium", "low"];

const PRIORITY_LABELS: Record<ReviewCommentPriority, string> = {
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
};

const PRIORITY_HEADER_COLORS: Record<ReviewCommentPriority, string> = {
  high: "text-red-400",
  medium: "text-amber-400",
  low: "text-blue-400",
};

const RISK_COLORS: Record<ReviewRiskLevel, string> = {
  low: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  medium: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  high: "bg-red-500/15 text-red-400 border-red-500/30",
};

interface ReviewCommentListProps {
  review: ReviewDetail;
}

export function ReviewCommentList({ review }: ReviewCommentListProps) {
  // Use local state for optimistic updates
  const [comments, setComments] = useState<ReviewCommentDetail[]>(
    review.comments,
  );

  const handleOptimisticUpdate = useCallback(
    (commentId: string, updates: Partial<ReviewCommentDetail>) => {
      setComments((prev) =>
        prev.map((c) => (c.id === commentId ? { ...c, ...updates } : c)),
      );
    },
    [],
  );

  const handleCommentAdded = useCallback(() => {
    // In real implementation, this would refetch from the server.
    // For now it's a no-op since the server action is a stub.
  }, []);

  const grouped = useMemo(() => {
    const groups: Record<ReviewCommentPriority, ReviewCommentDetail[]> = {
      high: [],
      medium: [],
      low: [],
    };
    for (const comment of comments) {
      groups[comment.priority].push(comment);
    }
    return groups;
  }, [comments]);

  const stats = useMemo(() => {
    const counts: Record<ReviewCommentPriority, number> = {
      high: 0,
      medium: 0,
      low: 0,
    };
    let included = 0;
    for (const comment of comments) {
      counts[comment.priority]++;
      if (comment.included) included++;
    }
    return { counts, included, total: comments.length };
  }, [comments]);

  const preExistingCount = useMemo(
    () => comments.filter((c) => c.introducedByPr === false).length,
    [comments],
  );

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto flex-1">
      {/* Review Summary Header */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          {review.riskLevel && (
            <Badge
              className={cn(
                "text-xs uppercase tracking-wider border",
                RISK_COLORS[review.riskLevel],
              )}
            >
              {review.riskLevel} risk
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {stats.counts.high > 0 && (
              <span className="text-red-400">{stats.counts.high} HIGH</span>
            )}
            {stats.counts.high > 0 && stats.counts.medium > 0 && ", "}
            {stats.counts.medium > 0 && (
              <span className="text-amber-400">
                {stats.counts.medium} MEDIUM
              </span>
            )}
            {(stats.counts.high > 0 || stats.counts.medium > 0) &&
              stats.counts.low > 0 &&
              ", "}
            {stats.counts.low > 0 && (
              <span className="text-blue-400">{stats.counts.low} LOW</span>
            )}
            {" — "}
            {stats.included}/{stats.total} included
          </span>
        </div>

        {/* Summary (collapsible) */}
        {review.summary && (
          <Collapsible defaultOpen>
            <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors group w-full">
              <ChevronDownIcon className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
              Summary
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p className="mt-1.5 text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed pl-6">
                {review.summary}
              </p>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Done Well (collapsible) */}
        {review.doneWell && (
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors group w-full">
              <ChevronDownIcon className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
              Done Well
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p className="mt-1.5 text-sm text-emerald-400/80 whitespace-pre-wrap leading-relaxed pl-6">
                {review.doneWell}
              </p>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>

      {/* Comment Groups */}
      <div className="flex flex-col gap-4">
        {PRIORITY_ORDER.map((priority) => {
          const group = grouped[priority];
          if (group.length === 0) return null;

          return (
            <div key={priority} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <h4
                  className={cn(
                    "text-xs font-semibold uppercase tracking-wider",
                    PRIORITY_HEADER_COLORS[priority],
                  )}
                >
                  {PRIORITY_LABELS[priority]}
                </h4>
                <Badge variant="outline" className="text-[10px]">
                  {group.length}
                </Badge>
              </div>
              <div className="flex flex-col gap-2">
                {group.map((comment) => (
                  <ReviewCommentItem
                    key={comment.id}
                    comment={comment}
                    onOptimisticUpdate={handleOptimisticUpdate}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Comment Form */}
      <ReviewAddCommentForm
        reviewId={review.id}
        onCommentAdded={handleCommentAdded}
      />

      {/* Bulk Actions Bar */}
      {preExistingCount > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {preExistingCount} pre-existing issue
            {preExistingCount !== 1 ? "s" : ""}
          </span>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            title="Bulk triage to Linear (coming soon)"
          >
            Triage Pre-existing
          </button>
        </div>
      )}
    </div>
  );
}
