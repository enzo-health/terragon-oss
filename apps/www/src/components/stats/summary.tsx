"use client";

import type { UsageStatsSummary } from "@/server-actions/stats";

interface SummaryProps {
  summary: UsageStatsSummary;
}

export function Summary({ summary }: SummaryProps) {
  return (
    <dl className="flex items-center gap-5 text-sm">
      <div className="flex items-baseline gap-1.5">
        <dt className="sr-only">Tasks created</dt>
        <dd className="text-base font-medium tabular-nums text-foreground">
          {summary.totalThreadsCreated.toLocaleString("en-US")}
        </dd>
        <span className="text-muted-foreground">
          {summary.totalThreadsCreated === 1 ? "task created" : "tasks created"}
        </span>
      </div>
      <span aria-hidden="true" className="h-3.5 w-px bg-hairline-strong" />
      <div className="flex items-baseline gap-1.5">
        <dt className="sr-only">PRs merged</dt>
        <dd className="text-base font-medium tabular-nums text-foreground">
          {summary.totalPRsMerged.toLocaleString("en-US")}
        </dd>
        <span className="text-muted-foreground">
          {summary.totalPRsMerged === 1 ? "PR merged" : "PRs merged"}
        </span>
      </div>
    </dl>
  );
}
