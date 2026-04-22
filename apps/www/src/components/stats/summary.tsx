"use client";

import type { UsageStatsSummary } from "@/server-actions/stats";

interface SummaryProps {
  summary: UsageStatsSummary;
}

export function Summary({ summary }: SummaryProps) {
  return (
    <div className="flex items-center gap-4 text-sm">
      <div className="flex items-center gap-1.5">
        <span className="font-medium">
          {summary.totalThreadsCreated.toLocaleString("en-US")}
        </span>
        <span className="text-muted-foreground">Tasks Created</span>
      </div>
      <span className="text-border">|</span>
      <div className="flex items-center gap-1.5">
        <span className="font-medium">
          {summary.totalPRsMerged.toLocaleString("en-US")}
        </span>
        <span className="text-muted-foreground">PRs Merged</span>
      </div>
    </div>
  );
}
