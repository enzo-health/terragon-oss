"use client";

import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitPullRequestIcon,
} from "lucide-react";
import { ReviewBotFeedback } from "./review-bot-feedback";
import type { ReviewDetail } from "@/types/review";

interface ReviewPRContextProps {
  review: ReviewDetail;
}

function CIBanner({ ciStatus }: { ciStatus: ReviewDetail["ciStatus"] }) {
  if (ciStatus === "passing" || ciStatus === "unknown") return null;

  const config = {
    failing: {
      bg: "bg-red-500/10 border-red-500/30",
      text: "text-red-400",
      message: "CI checks are failing",
    },
    pending: {
      bg: "bg-yellow-500/10 border-yellow-500/30",
      text: "text-yellow-400",
      message: "CI checks are pending",
    },
  };

  const c = config[ciStatus];

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
        c.bg,
      )}
    >
      <AlertTriangleIcon className={cn("h-4 w-4 shrink-0", c.text)} />
      <span className={c.text}>{c.message}</span>
    </div>
  );
}

function ConflictBanner({ hasConflicts }: { hasConflicts: boolean }) {
  if (!hasConflicts) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm">
      <AlertTriangleIcon className="h-4 w-4 shrink-0 text-red-400" />
      <span className="text-red-400">This PR has merge conflicts</span>
    </div>
  );
}

function DiffStatsDisplay({
  diffStats,
}: {
  diffStats: ReviewDetail["diffStats"];
}) {
  if (!diffStats) return null;

  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span>
        {diffStats.files} file{diffStats.files !== 1 ? "s" : ""}
      </span>
      <span className="text-emerald-400">+{diffStats.additions}</span>
      <span className="text-red-400">-{diffStats.deletions}</span>
    </div>
  );
}

export function ReviewPRContext({ review }: ReviewPRContextProps) {
  return (
    <div className="flex flex-col gap-4 p-6 overflow-y-auto">
      {/* PR Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-3">
          <GitPullRequestIcon className="h-5 w-5 mt-0.5 shrink-0 text-muted-foreground" />
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-foreground leading-tight">
                {review.prTitle}
              </h2>
              <a
                href={review.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
              >
                <ExternalLinkIcon className="h-4 w-4" />
              </a>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="font-mono text-xs">
                {review.repoFullName}#{review.prNumber}
              </span>
              <span>by</span>
              <span className="font-medium">{review.prAuthor}</span>
            </div>
            {(review.prBaseBranch || review.prHeadBranch) && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <GitBranchIcon className="h-3 w-3" />
                <span className="font-mono">{review.prBaseBranch ?? "?"}</span>
                <span>&larr;</span>
                <span className="font-mono">{review.prHeadBranch ?? "?"}</span>
              </div>
            )}
            <DiffStatsDisplay diffStats={review.diffStats} />
          </div>
        </div>
      </div>

      {/* Warning Banners */}
      <ConflictBanner hasConflicts={review.hasConflicts} />
      <CIBanner ciStatus={review.ciStatus} />

      {/* PR Description */}
      <Collapsible>
        <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors group w-full">
          <ChevronDownIcon className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
          PR Description
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 rounded-lg border border-border/50 bg-muted/20 p-4 text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
            {review.summary || "No description provided."}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Code Change Summary */}
      {review.codeChangeSummary && (
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4">
          <h3 className="text-sm font-semibold text-foreground mb-2">
            Code Change Summary
          </h3>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
            {review.codeChangeSummary}
          </p>
        </div>
      )}

      {/* Bot Feedback */}
      {review.botFeedback && review.botFeedback.length > 0 && (
        <ReviewBotFeedback feedback={review.botFeedback} />
      )}

      {/* PR Diff Placeholder */}
      <div className="rounded-lg border border-border/50 bg-muted/10 p-6 text-center">
        <p className="text-sm text-muted-foreground mb-2">PR Diff</p>
        <a
          href={`${review.prUrl}/files`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 transition-colors"
        >
          View diff on GitHub
          <ExternalLinkIcon className="h-3.5 w-3.5" />
        </a>
        {/* TODO: Integrate the GitDiffView component once the diff text is available in ReviewDetail.
            The existing GitDiffView requires a ThreadInfoFull context (thread.gitDiff, thread.gitDiffStats).
            When the backend provides raw diff text, create a simplified wrapper that passes it to
            parseMultiFileDiff and renders via FileDiffWrapper components. */}
      </div>
    </div>
  );
}
