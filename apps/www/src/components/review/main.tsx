"use client";

import { Loader2, ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { reviewsQueryOptions } from "@/queries/review-queries";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ACTIVE_PHASES, COMPLETED_PHASES } from "@/types/review";
import type { ReviewForDashboard } from "@/types/review";
import { ReviewCard } from "./review-card";

export function Reviews() {
  const { data: reviews, isLoading, error } = useQuery(reviewsQueryOptions());

  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Error loading reviews. Please try again.
        </p>
      </div>
    );
  }

  const activeReviews = (reviews ?? []).filter((r) =>
    ACTIVE_PHASES.has(r.phase),
  );
  const completedReviews = (reviews ?? []).filter((r) =>
    COMPLETED_PHASES.has(r.phase),
  );

  const totalActive = activeReviews.length;

  return (
    <div className="flex flex-col gap-6">
      {/* Page title */}
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Reviews</h1>
        {totalActive > 0 && (
          <Badge variant="secondary" className="text-xs">
            {totalActive}
          </Badge>
        )}
      </div>

      {reviews?.length === 0 && <EmptyState />}

      {/* Active section */}
      {activeReviews.length > 0 && (
        <ReviewSection title="Active" reviews={activeReviews} />
      )}

      {/* Completed section (collapsed by default) */}
      {completedReviews.length > 0 && (
        <CompletedSection reviews={completedReviews} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="p-4 bg-muted/50 rounded-lg border">
      <h3 className="text-sm font-medium text-muted-foreground mb-2">
        No Reviews
      </h3>
      <p className="text-sm text-muted-foreground">
        When you have active PR reviews, they will appear here. Reviews are
        created when the AI review agent is triggered on one of your pull
        requests.
      </p>
    </div>
  );
}

function ReviewSection({
  title,
  reviews,
}: {
  title: string;
  reviews: ReviewForDashboard[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/60">
        {title}
      </h2>
      <div className="flex flex-col gap-2">
        {reviews.map((review) => (
          <ReviewCard key={review.id} review={review} />
        ))}
      </div>
    </div>
  );
}

function CompletedSection({ reviews }: { reviews: ReviewForDashboard[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 group cursor-pointer">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/60">
          Completed
        </h2>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
          {reviews.length}
        </Badge>
        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground/60 transition-transform",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 mt-2">
          {reviews.map((review) => (
            <ReviewCard key={review.id} review={review} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
