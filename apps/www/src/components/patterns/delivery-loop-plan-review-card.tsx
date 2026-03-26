"use client";

import { cn } from "@/lib/utils";
import { ChevronRight, ExternalLink } from "lucide-react";
import type {
  PlanSpecViewModel,
  TaskStatus,
} from "@/lib/delivery-loop-plan-view-model";
import { useCallback, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";

function getTaskStatusDotClass(status: TaskStatus): string {
  switch (status) {
    case "pending":
      return "bg-muted-foreground/30";
    case "in_progress":
      return "bg-blue-500 animate-pulse";
    case "completed":
      return "bg-emerald-500";
    case "error":
      return "bg-red-500";
  }
}

function ShimmerRow() {
  return (
    <div className="flex items-center gap-3 py-2">
      <Skeleton className="h-4 w-4" />
      <Skeleton className="h-4 flex-1" />
    </div>
  );
}

export function DeliveryLoopPlanReviewCard({
  plan,
  className,
  isStreaming,
  onOpenInArtifactWorkspace,
}: {
  plan: PlanSpecViewModel;
  className?: string;
  isStreaming?: boolean;
  onOpenInArtifactWorkspace?: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const isTaskExpanded = useCallback(
    (taskId: string) => expanded[taskId] ?? false,
    [expanded],
  );

  const toggleTask = useCallback((taskId: string) => {
    setExpanded((prev) => ({ ...prev, [taskId]: !prev[taskId] }));
  }, []);

  const allExpanded = plan.tasks.every(
    (t) => expanded[t.stableTaskId] === true,
  );

  const toggleAll = useCallback(() => {
    const next = !allExpanded;
    const bulk: Record<string, boolean> = {};
    for (const task of plan.tasks) {
      bulk[task.stableTaskId] = next;
    }
    setExpanded(bulk);
  }, [allExpanded, plan.tasks]);

  return (
    <section
      aria-label="Delivery loop plan review"
      className={cn(
        "rounded-lg border bg-card p-3 text-card-foreground",
        className,
      )}
    >
      <header className="space-y-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {isStreaming && (
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
            )}
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Plan Review
            </p>
          </div>
          {onOpenInArtifactWorkspace && (
            <button
              onClick={onOpenInArtifactWorkspace}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-muted transition-colors"
              title="Open in side panel"
              aria-label="Open plan in side panel"
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden />
            </button>
          )}
        </div>
        {plan.title ? (
          <h3 className="text-sm font-semibold leading-tight">{plan.title}</h3>
        ) : isStreaming ? (
          <div className="h-4 w-48 rounded bg-muted animate-pulse" />
        ) : (
          <h3 className="text-sm font-semibold leading-tight">{plan.title}</h3>
        )}
        {plan.summary ? (
          <p className="text-xs text-muted-foreground whitespace-pre-wrap">
            {plan.summary}
          </p>
        ) : isStreaming ? (
          <div className="space-y-1.5">
            <div className="h-3 w-full rounded bg-muted animate-pulse" />
            <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground whitespace-pre-wrap">
            {plan.summary}
          </p>
        )}
      </header>

      <div className="mt-3 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Tasks ({plan.tasks.length})
          </h4>
          <button
            onClick={toggleAll}
            className="text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
        </div>
        <ol className="space-y-2">
          {plan.tasks.length === 0 && isStreaming && (
            <>
              <ShimmerRow />
              <ShimmerRow />
            </>
          )}
          {plan.tasks.map((task, idx) => {
            const open = isTaskExpanded(task.stableTaskId);
            const hasContent = !!task.description || task.acceptance.length > 0;
            return (
              <li
                key={task.stableTaskId}
                className="rounded-md border bg-muted/30"
              >
                <button
                  type="button"
                  onClick={() => hasContent && toggleTask(task.stableTaskId)}
                  className={cn(
                    "flex w-full items-center gap-1.5 p-2 text-left",
                    hasContent && "cursor-pointer",
                  )}
                  aria-expanded={open}
                  disabled={!hasContent}
                >
                  {hasContent && (
                    <ChevronRight
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
                        open && "rotate-90",
                      )}
                      aria-hidden
                    />
                  )}
                  {task.status != null && (
                    <span
                      className={cn(
                        "size-2 rounded-full shrink-0",
                        getTaskStatusDotClass(task.status),
                      )}
                      role="img"
                      aria-label={`Task status: ${task.status}`}
                    />
                  )}
                  <span className="text-xs font-semibold">
                    {idx + 1}. {task.title}
                  </span>
                </button>

                {hasContent && (
                  <div
                    className="grid transition-[grid-template-rows] duration-200 ease-out"
                    style={{
                      gridTemplateRows: open ? "1fr" : "0fr",
                    }}
                  >
                    <div className="overflow-hidden min-h-0">
                      <div className="px-2 pb-2 pl-7">
                        {task.description && (
                          <p className="text-xs text-muted-foreground">
                            {task.description}
                          </p>
                        )}
                        {task.acceptance.length > 0 && (
                          <div className="mt-1.5">
                            <p className="text-[11px] font-medium text-muted-foreground">
                              Acceptance criteria
                            </p>
                            <ul className="mt-1 list-disc pl-4 text-xs text-foreground">
                              {task.acceptance.map((criterion) => (
                                <li key={`${task.stableTaskId}-${criterion}`}>
                                  {criterion}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
          {isStreaming && plan.tasks.length > 0 && (
            <>
              <ShimmerRow />
              <ShimmerRow />
            </>
          )}
        </ol>
      </div>

      {plan.assumptions.length > 0 && (
        <div className="mt-3 space-y-1">
          <h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Assumptions / Defaults
          </h4>
          <ul className="list-disc pl-4 text-xs text-foreground">
            {plan.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
