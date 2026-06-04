"use client";

import { ArchiveX, List, WorkflowIcon } from "lucide-react";
import type { ThreadListFilters } from "@/queries/thread-queries";

export function EmptyThreadList({
  queryFilters,
}: {
  queryFilters: ThreadListFilters;
}) {
  if (queryFilters.automationId) {
    return (
      <div className="bg-muted/20 rounded-md p-8 flex flex-col items-center justify-center gap-2">
        <div className="flex items-center gap-2">
          <WorkflowIcon className="size-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            No tasks for this automation
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-lg p-8 flex flex-col items-center justify-center gap-3 text-center">
      {queryFilters.archived ? (
        <ArchiveX className="size-5 text-muted-foreground" />
      ) : (
        <List className="size-5 text-muted-foreground" />
      )}
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">
          {queryFilters.archived ? "No archived tasks" : "No tasks yet"}
        </span>
        {!queryFilters.archived && (
          <span className="text-xs text-muted-foreground">
            Your tasks appear here.
          </span>
        )}
      </div>
    </div>
  );
}
