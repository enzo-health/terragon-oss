import Link from "next/link";
import { ExternalLink, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  ReviewForDashboard,
  ReviewPhase,
  ReviewPRState,
  ReviewCIStatus,
} from "@/types/review";

// ---------------------------------------------------------------------------
// Phase helpers
// ---------------------------------------------------------------------------

const PHASE_LABELS: Record<ReviewPhase, string> = {
  ai_reviewing: "AI Reviewing...",
  waiting_human: "Ready for Review",
  posting: "Posting...",
  await_author_fixes: "Await Author Fixes",
  re_reviewing: "Re-Reviewing...",
  complete: "Complete",
  cancelled: "Cancelled",
};

function getActionBadge(phase: ReviewPhase) {
  switch (phase) {
    case "ai_reviewing":
    case "re_reviewing":
      return {
        label: "In Progress",
        className: "bg-blue-500/15 text-blue-400 border-blue-500/25",
      };
    case "waiting_human":
      return {
        label: "Needs Input",
        className: "bg-amber-500/15 text-amber-400 border-amber-500/25",
      };
    case "posting":
      return {
        label: "Posting",
        className: "bg-blue-500/15 text-blue-400 border-blue-500/25",
      };
    case "await_author_fixes":
      return {
        label: "Awaiting Author",
        className: "bg-orange-500/15 text-orange-400 border-orange-500/25",
      };
    case "complete":
      return {
        label: "Done",
        className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        className: "bg-neutral-500/15 text-neutral-400 border-neutral-500/25",
      };
  }
}

// ---------------------------------------------------------------------------
// PR state badge
// ---------------------------------------------------------------------------

function prStateBadge(state: ReviewPRState) {
  switch (state) {
    case "open":
      return {
        label: "Open",
        className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
      };
    case "draft":
      return {
        label: "Draft",
        className: "bg-neutral-500/15 text-neutral-400 border-neutral-500/25",
      };
    case "merged":
      return {
        label: "Merged",
        className: "bg-purple-500/15 text-purple-400 border-purple-500/25",
      };
    case "closed":
      return {
        label: "Closed",
        className: "bg-red-500/15 text-red-400 border-red-500/25",
      };
  }
}

// ---------------------------------------------------------------------------
// CI status dot
// ---------------------------------------------------------------------------

function CIStatusDot({ status }: { status: ReviewCIStatus }) {
  const color: Record<ReviewCIStatus, string> = {
    passing: "bg-emerald-400",
    failing: "bg-red-400",
    pending: "bg-yellow-400",
    unknown: "bg-neutral-400",
  };
  return (
    <span
      className={cn("inline-block size-2 rounded-full shrink-0", color[status])}
      title={`CI: ${status}`}
    />
  );
}

// ---------------------------------------------------------------------------
// ReviewCard
// ---------------------------------------------------------------------------

export function ReviewCard({ review }: { review: ReviewForDashboard }) {
  const phaseLabel = PHASE_LABELS[review.phase];
  const action = getActionBadge(review.phase);
  const prState = prStateBadge(review.prState);

  return (
    <Link
      href={`/reviews/${review.id}`}
      className="group flex flex-col gap-2 rounded-lg border border-border/50 bg-card p-4 transition-colors hover:border-border hover:bg-accent/30"
    >
      {/* Top row: title + badges */}
      <div className="flex items-start justify-between gap-3">
        {/* Left: title & phase */}
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-sm font-semibold leading-snug truncate">
            PR #{review.prNumber}: {review.prTitle}
          </span>
          <span className="text-xs text-muted-foreground">{phaseLabel}</span>
        </div>

        {/* Right: badges */}
        <div className="flex shrink-0 items-center gap-1.5 flex-wrap justify-end">
          <Badge
            variant="outline"
            className={cn("text-[10px] px-1.5 py-0", prState.className)}
          >
            {prState.label}
          </Badge>
          <CIStatusDot status={review.ciStatus} />
          <Badge
            variant="outline"
            className="text-[10px] px-1.5 py-0 bg-purple-500/15 text-purple-400 border-purple-500/25"
          >
            PR Review
          </Badge>
          <Badge
            variant="outline"
            className={cn("text-[10px] px-1.5 py-0", action.className)}
          >
            {action.label}
          </Badge>
        </div>
      </div>

      {/* Bottom row: metadata */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
        <span>{review.createdAt.toLocaleString()}</span>
        <span className="text-muted-foreground/40">|</span>
        <a
          href={review.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-0.5 hover:text-foreground transition-colors"
        >
          <ExternalLink className="size-3" />
          <span>#{review.prNumber}</span>
        </a>
        <span className="text-muted-foreground/40">|</span>
        <span>by {review.prAuthor}</span>

        {review.hasConflicts && (
          <>
            <span className="text-muted-foreground/40">|</span>
            <span className="inline-flex items-center gap-0.5 text-amber-400">
              <AlertTriangle className="size-3" />
              Conflicts
            </span>
          </>
        )}

        {review.diffStats && (
          <>
            <span className="text-muted-foreground/40">|</span>
            <span>
              <span className="text-emerald-400">
                +{review.diffStats.additions}
              </span>{" "}
              <span className="text-red-400">
                -{review.diffStats.deletions}
              </span>
            </span>
          </>
        )}
      </div>
    </Link>
  );
}
