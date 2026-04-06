"use client";

import { useCallback, useState } from "react";
import type {
  DeliveryLoopStatusCheck,
  DeliveryLoopStatusCheckKey,
  DeliveryLoopStatusCheckStatus,
} from "@/lib/delivery-loop-status";
import { cn } from "@/lib/utils";
import { useDeliveryLoopStatusQuery } from "@/queries/delivery-loop-status-queries";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import { approvePlan } from "@/server-actions/approve-plan";
import {
  requestDeliveryLoopBypassCurrentGateOnce,
  requestDeliveryLoopResumeFromBlocked,
} from "@/server-actions/delivery-loop-interventions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import {
  buildArtifactFallbackPlanSpecViewModel,
  type PlanTaskViewModel,
  type TaskStatus,
} from "@/lib/delivery-loop-plan-view-model";
import { DeliveryLoopPlanReviewCard } from "./delivery-loop-plan-review-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertTriangleIcon,
  CheckIcon,
  CircleIcon,
  GitPullRequestIcon,
  InfoIcon,
  LoaderCircleIcon,
} from "lucide-react";

function mapDeliveryTaskStatusToTaskStatus(
  status: DeliveryPlannedTask["status"],
): TaskStatus {
  switch (status) {
    case "done":
    case "skipped":
      return "completed";
    case "in_progress":
      return "in_progress";
    case "blocked":
      return "error";
    case "todo":
    default:
      return "pending";
  }
}

type DeliveryPhaseKey =
  | "planning"
  | "implementing"
  | "reviewing"
  | "ci"
  | "ui_testing";

// ---------------------------------------------------------------------------
// Check key → phase key mapping
// ---------------------------------------------------------------------------
const CHECK_TO_PHASE: Record<DeliveryLoopStatusCheckKey, DeliveryPhaseKey> = {
  ci: "ci",
  review_threads: "reviewing",
  deep_review: "reviewing",
  architecture_carmack: "reviewing",
  video: "ui_testing",
};

function getChecksForPhase(
  checks: DeliveryLoopStatusCheck[],
  phaseKey: DeliveryPhaseKey,
): DeliveryLoopStatusCheck[] {
  return checks.filter((c) => CHECK_TO_PHASE[c.key] === phaseKey);
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function getCheckStatusLabel(status: DeliveryLoopStatusCheckStatus): string {
  switch (status) {
    case "passed":
      return "Passed";
    case "blocked":
      return "Blocked";
    case "degraded":
      return "Degraded";
    case "not_started":
      return "Not Started";
    default:
      return "In Progress";
  }
}

function getGateDotColor(status: DeliveryLoopStatusCheckStatus): string {
  switch (status) {
    case "passed":
      return "bg-emerald-500";
    case "blocked":
      return "bg-red-500";
    case "degraded":
      return "bg-amber-500";
    case "not_started":
      return "bg-muted-foreground/30";
    default:
      return "bg-sky-500";
  }
}

// ---------------------------------------------------------------------------
// Gate tooltip content (shows sub-checks for a phase on hover)
// ---------------------------------------------------------------------------

function GateTooltipContent({
  gateChecks,
}: {
  gateChecks: DeliveryLoopStatusCheck[];
}) {
  return (
    <div className="space-y-1.5 text-left">
      {gateChecks.map((check) => (
        <div key={check.key} className="flex items-start gap-1.5">
          <div
            className={cn(
              "mt-1 size-1.5 shrink-0 rounded-full",
              getGateDotColor(check.status),
            )}
          />
          <div>
            <span className="font-medium">{check.label}</span>
            <span className="mx-1 text-primary-foreground/60">·</span>
            <span className="text-primary-foreground/80">
              {getCheckStatusLabel(check.status)}
            </span>
            <p className="text-primary-foreground/60">{check.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan task list
// ---------------------------------------------------------------------------

type DeliveryPlannedTask = {
  stableTaskId: string;
  title: string;
  description: string | null;
  acceptance: string[];
  status: "todo" | "in_progress" | "done" | "blocked" | "skipped";
};

function PlanTaskStatusIcon({
  status,
}: {
  status: DeliveryPlannedTask["status"];
}) {
  switch (status) {
    case "done":
    case "skipped":
      return <CheckIcon className="size-3 shrink-0 text-emerald-600" />;
    case "in_progress":
      return (
        <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-foreground" />
      );
    case "blocked":
      return <AlertTriangleIcon className="size-3 shrink-0 text-destructive" />;
    default:
      return (
        <CircleIcon className="size-3 shrink-0 text-muted-foreground/50" />
      );
  }
}

function DeliveryPlanTaskList({
  tasks,
  taskSummary,
  showApprove,
  threadId,
  threadChatId,
}: {
  tasks: DeliveryPlannedTask[];
  taskSummary: { total: number; done: number; remaining: number };
  showApprove: boolean;
  threadId: string;
  threadChatId: string | null;
}) {
  const approveMutation = useServerActionMutation({
    mutationFn: approvePlan,
  });

  const handleApprove = useCallback(async () => {
    if (!threadChatId) return;
    await approveMutation.mutateAsync({ threadId, threadChatId });
  }, [threadId, threadChatId, approveMutation]);

  return (
    <div className="mt-1.5 rounded-md border bg-muted/30 px-3 py-2">
      <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
        {taskSummary.done} of {taskSummary.total} tasks complete
      </p>
      <ul className="space-y-1">
        {tasks.map((task) => (
          <li
            key={task.stableTaskId}
            className="flex items-center gap-2 text-[12px] leading-tight"
          >
            <PlanTaskStatusIcon status={task.status} />
            <span
              className={cn(
                "truncate",
                task.status === "done" || task.status === "skipped"
                  ? "text-muted-foreground line-through"
                  : "text-foreground",
              )}
            >
              {task.title}
            </span>
          </li>
        ))}
      </ul>
      {showApprove && threadChatId && (
        <Button
          size="sm"
          className="mt-2 h-7 text-xs"
          disabled={approveMutation.isPending}
          onClick={handleApprove}
        >
          {approveMutation.isPending ? "Approving…" : "Approve Plan"}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Intervention controls
// ---------------------------------------------------------------------------

function DeliveryInterventionControls({
  threadId,
  threadChatId,
  canResume,
  canBypassOnce,
}: {
  threadId: string;
  threadChatId: string | null;
  canResume: boolean;
  canBypassOnce: boolean;
}) {
  const resumeMutation = useServerActionMutation({
    mutationFn: requestDeliveryLoopResumeFromBlocked,
  });
  const bypassMutation = useServerActionMutation({
    mutationFn: requestDeliveryLoopBypassCurrentGateOnce,
  });

  const handleResume = useCallback(async () => {
    await resumeMutation.mutateAsync({ threadId, threadChatId });
  }, [resumeMutation, threadChatId, threadId]);
  const handleBypass = useCallback(async () => {
    await bypassMutation.mutateAsync({ threadId, threadChatId });
  }, [bypassMutation, threadChatId, threadId]);

  return (
    <div className="mt-2 flex gap-2">
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        disabled={resumeMutation.isPending || !canResume}
        onClick={handleResume}
      >
        {resumeMutation.isPending ? "Resuming…" : "Resume"}
      </Button>
      {canBypassOnce && (
        <Button
          size="sm"
          variant="secondary"
          className="h-7 text-xs"
          disabled={bypassMutation.isPending}
          onClick={handleBypass}
        >
          {bypassMutation.isPending ? "Bypassing…" : "Bypass Once"}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DeliveryLoopTopProgressStepper({
  threadId,
  threadChatId,
  enabled,
}: {
  threadId: string;
  threadChatId: string | null;
  enabled: boolean;
}) {
  const [expandedPhase, setExpandedPhase] = useState<DeliveryPhaseKey | null>(
    null,
  );
  const { data, isLoading, isError } = useDeliveryLoopStatusQuery({
    threadId,
    enabled,
  });
  const deliveryPlanReviewCard = useFeatureFlag("deliveryPlanReviewCard");

  if (!enabled || isError) return null;

  const phases =
    data?.phases ??
    (isLoading
      ? ([
          { key: "planning", label: "Planning", status: "pending" },
          { key: "implementing", label: "Implementing", status: "not_started" },
          { key: "reviewing", label: "Reviewing", status: "not_started" },
          { key: "ci", label: "CI", status: "not_started" },
          { key: "ui_testing", label: "UI Testing", status: "not_started" },
        ] satisfies ReadonlyArray<{
          key: DeliveryPhaseKey;
          label: string;
          status: DeliveryLoopStatusCheckStatus;
        }>)
      : []);

  const progressPercent = data?.progressPercent ?? 0;
  const stateLabel = data?.stateLabel ?? "Waiting to Start";
  const explanation = data?.explanation ?? null;
  const needsAttention = data?.needsAttention ?? null;
  const checks = data?.checks ?? [];
  const links = data?.links ?? null;
  const showInterventionControls =
    (data?.actions.canResume ?? false) ||
    (data?.actions.canBypassOnce ?? false);

  const planCardModel =
    data && deliveryPlanReviewCard
      ? buildArtifactFallbackPlanSpecViewModel({
          summary:
            data.artifacts.planningArtifact?.planText ??
            "Structured plan captured for this task.",
          tasks: data.artifacts.plannedTasks.map<PlanTaskViewModel>((task) => ({
            stableTaskId: task.stableTaskId,
            title: task.title,
            description: task.description,
            acceptance: task.acceptance,
            status: mapDeliveryTaskStatusToTaskStatus(task.status),
          })),
        })
      : null;

  return (
    <div className="w-full border-b border-border/50">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-1.5 px-4 py-1.5">
        {/* Inline header + segmented bar */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
              Delivery
            </span>
            <span className="text-muted-foreground/30">·</span>
            <span className="text-[12px] font-medium text-foreground">
              {stateLabel}
            </span>
            {explanation && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <InfoIcon className="size-3 shrink-0 cursor-help text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[280px]">
                  {explanation}
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {links?.pullRequestUrl && (
            <a
              href={links.pullRequestUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              <GitPullRequestIcon className="size-3" />
              PR
            </a>
          )}

          {/* Segmented progress bar — each phase is a colored segment */}
          <div
            className="flex flex-1 items-center gap-0.5 mx-2"
            role="group"
            aria-label="Delivery phases"
          >
            {phases.map((phase) => {
              const phaseChecks = getChecksForPhase(checks, phase.key);
              const hasGateChecks = phaseChecks.length > 0;
              const isExpandable =
                phase.key === "planning" &&
                (data?.artifacts?.plannedTasks?.length ?? 0) > 0;
              const segment = (
                <Tooltip key={phase.key}>
                  <TooltipTrigger asChild>
                    <div
                      onClick={
                        isExpandable
                          ? () =>
                              setExpandedPhase((prev) =>
                                prev === phase.key ? null : phase.key,
                              )
                          : undefined
                      }
                      className={cn(
                        "flex-1 h-[4px] rounded-full transition-all duration-300 hover:h-[6px]",
                        isExpandable ? "cursor-pointer" : "cursor-default",
                        phase.status === "passed" || phase.status === "degraded"
                          ? "bg-emerald-500"
                          : phase.status === "pending"
                            ? "bg-amber-400 animate-pulse"
                            : phase.status === "blocked"
                              ? "bg-red-500"
                              : "bg-border",
                      )}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    <div className="font-medium">{phase.label}</div>
                    <div className="text-primary-foreground/70">
                      {getCheckStatusLabel(phase.status)}
                    </div>
                    {hasGateChecks && (
                      <div className="mt-1 border-t border-primary-foreground/20 pt-1">
                        <GateTooltipContent gateChecks={phaseChecks} />
                      </div>
                    )}
                  </TooltipContent>
                </Tooltip>
              );
              return segment;
            })}
          </div>

          <span className="text-[11px] font-semibold tabular-nums text-muted-foreground shrink-0">
            {isLoading ? "--" : `${progressPercent}%`}
          </span>
          <span aria-live="polite" className="shrink-0">
            {needsAttention?.isBlocked ? (
              <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                {needsAttention.blockerCount} blocker
                {needsAttention.blockerCount === 1 ? "" : "s"}
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                On Track
              </Badge>
            )}
          </span>
        </div>

        {/* Blocker summary */}
        {needsAttention?.isBlocked && needsAttention.topBlockers.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-red-200 bg-red-50/50 px-2.5 py-1 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
            <AlertTriangleIcon className="size-3 shrink-0" />
            {needsAttention.topBlockers.map((b, i) => (
              <span key={i}>{b.title}</span>
            ))}
          </div>
        )}

        {showInterventionControls && data && (
          <DeliveryInterventionControls
            threadId={threadId}
            threadChatId={threadChatId}
            canResume={data.actions.canResume}
            canBypassOnce={data.actions.canBypassOnce}
          />
        )}

        {/* Plan expansion (shown when planning phase has tasks) */}
        {expandedPhase === "planning" && data?.artifacts?.plannedTasks && (
          <div className="animate-in fade-in slide-in-from-top-1 duration-200">
            {planCardModel && (
              <DeliveryLoopPlanReviewCard
                plan={planCardModel}
                className="mt-1"
              />
            )}
            <DeliveryPlanTaskList
              tasks={data.artifacts.plannedTasks}
              taskSummary={data.artifacts.plannedTaskSummary}
              showApprove={data.actions.canApprovePlan}
              threadId={threadId}
              threadChatId={threadChatId}
            />
          </div>
        )}
      </div>
    </div>
  );
}
