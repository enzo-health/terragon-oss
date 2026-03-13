"use client";

import { useCallback, useState } from "react";
import type {
  SdlcLoopStatusCheck,
  SdlcLoopStatusCheckKey,
  SdlcLoopStatusCheckStatus,
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
import { Progress } from "@/components/ui/progress";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import {
  buildArtifactFallbackPlanSpecViewModel,
  type PlanTaskViewModel,
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
  ChevronDownIcon,
  CircleIcon,
  ExternalLinkIcon,
  InfoIcon,
  LoaderCircleIcon,
  ShieldCheckIcon,
  GitPullRequestIcon,
  EyeIcon,
  MessageSquareIcon,
  CodeIcon,
  MonitorPlayIcon,
} from "lucide-react";

type SdlcPhaseKey =
  | "planning"
  | "implementing"
  | "reviewing"
  | "ci"
  | "ui_testing";

// ---------------------------------------------------------------------------
// Check key → phase key mapping (which checks belong to which phase)
// ---------------------------------------------------------------------------
const CHECK_TO_PHASE: Record<SdlcLoopStatusCheckKey, SdlcPhaseKey> = {
  ci: "ci",
  review_threads: "reviewing",
  deep_review: "reviewing",
  architecture_carmack: "reviewing",
  video: "ui_testing",
};

const CHECK_ICONS: Record<SdlcLoopStatusCheckKey, React.ReactNode> = {
  ci: <CodeIcon className="size-3 shrink-0" />,
  review_threads: <MessageSquareIcon className="size-3 shrink-0" />,
  deep_review: <EyeIcon className="size-3 shrink-0" />,
  architecture_carmack: <ShieldCheckIcon className="size-3 shrink-0" />,
  video: <MonitorPlayIcon className="size-3 shrink-0" />,
};

function getChecksForPhase(
  checks: SdlcLoopStatusCheck[],
  phaseKey: SdlcPhaseKey,
): SdlcLoopStatusCheck[] {
  return checks.filter((c) => CHECK_TO_PHASE[c.key] === phaseKey);
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function getCheckStatusLabel(status: SdlcLoopStatusCheckStatus): string {
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

function getStatusColor(status: SdlcLoopStatusCheckStatus) {
  switch (status) {
    case "passed":
      return {
        badge:
          "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400",
        indicator: "bg-emerald-600 text-white",
        dot: "bg-emerald-500",
        text: "text-emerald-700 dark:text-emerald-400",
        line: "bg-emerald-500",
      };
    case "blocked":
      return {
        badge:
          "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400",
        indicator: "bg-red-600 text-white",
        dot: "bg-red-500",
        text: "text-red-700 dark:text-red-400",
        line: "bg-red-300 dark:bg-red-800",
      };
    case "degraded":
      return {
        badge:
          "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-400",
        indicator: "bg-amber-500 text-white",
        dot: "bg-amber-500",
        text: "text-amber-700 dark:text-amber-400",
        line: "bg-amber-300 dark:bg-amber-800",
      };
    case "not_started":
      return {
        badge: "border-border bg-muted text-muted-foreground",
        indicator: "bg-muted text-muted-foreground",
        dot: "bg-muted-foreground/30",
        text: "text-muted-foreground",
        line: "bg-border",
      };
    default:
      return {
        badge:
          "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-400",
        indicator: "bg-sky-600 text-white",
        dot: "bg-sky-500",
        text: "text-sky-700 dark:text-sky-400",
        line: "bg-sky-300 dark:bg-sky-800",
      };
  }
}

function PhaseIcon({
  status,
  phaseIndex,
}: {
  status: SdlcLoopStatusCheckStatus;
  phaseIndex: number;
}) {
  const colors = getStatusColor(status);

  if (status === "passed" || status === "degraded") {
    return (
      <div
        className={cn(
          "flex size-7 items-center justify-center rounded-full",
          colors.indicator,
        )}
      >
        <CheckIcon className="size-3.5" strokeWidth={2.5} />
      </div>
    );
  }

  if (status === "blocked") {
    return (
      <div
        className={cn(
          "flex size-7 items-center justify-center rounded-full",
          colors.indicator,
        )}
      >
        <AlertTriangleIcon className="size-3.5" />
      </div>
    );
  }

  if (status === "pending") {
    return (
      <div
        className={cn(
          "flex size-7 items-center justify-center rounded-full",
          colors.indicator,
        )}
      >
        <LoaderCircleIcon className="size-3.5 animate-spin" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex size-7 items-center justify-center rounded-full border-2 border-border bg-background text-[11px] font-semibold text-muted-foreground",
      )}
    >
      {phaseIndex + 1}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gate detail row (individual check within a phase)
// ---------------------------------------------------------------------------

function GateDetailRow({ check }: { check: SdlcLoopStatusCheck }) {
  const colors = getStatusColor(check.status);

  return (
    <div className="flex items-start gap-2 py-1">
      <div className="flex items-center gap-1.5 pt-px">
        <div className={cn("size-1.5 rounded-full shrink-0", colors.dot)} />
        <span className="text-muted-foreground">{CHECK_ICONS[check.key]}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-foreground">
            {check.label}
          </span>
          <span
            className={cn(
              "inline-flex rounded border px-1 py-px text-[9px] font-medium leading-tight",
              colors.badge,
            )}
          >
            {getCheckStatusLabel(check.status)}
          </span>
        </div>
        <p className="text-[10px] leading-snug text-muted-foreground">
          {check.detail}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blocker list
// ---------------------------------------------------------------------------

function BlockerList({
  topBlockers,
}: {
  topBlockers: Array<{ title: string; source: string }>;
}) {
  if (topBlockers.length === 0) return null;

  return (
    <div className="rounded-md border border-red-200 bg-red-50/50 px-2.5 py-2 dark:border-red-900 dark:bg-red-950/30">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-red-600 dark:text-red-400">
        Blockers
      </p>
      <ul className="space-y-0.5">
        {topBlockers.map((blocker, i) => (
          <li
            key={i}
            className="flex items-start gap-1.5 text-[11px] leading-snug text-red-700 dark:text-red-400"
          >
            <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
            <span>{blocker.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan task list (same as before, slightly refined)
// ---------------------------------------------------------------------------

type SdlcPlannedTask = {
  stableTaskId: string;
  title: string;
  description: string | null;
  acceptance: string[];
  status: "todo" | "in_progress" | "done" | "blocked" | "skipped";
};

function PlanTaskStatusIcon({ status }: { status: SdlcPlannedTask["status"] }) {
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

function SdlcPlanTaskList({
  tasks,
  taskSummary,
  showApprove,
  threadId,
  threadChatId,
}: {
  tasks: SdlcPlannedTask[];
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
    <div className="rounded-md border bg-muted/30 px-3 py-2">
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

function SdlcInterventionControls({
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
    <div className="flex gap-2">
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        disabled={resumeMutation.isPending || !canResume}
        onClick={handleResume}
      >
        {resumeMutation.isPending ? "Resuming…" : "Resume"}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        className="h-7 text-xs"
        disabled={bypassMutation.isPending || !canBypassOnce}
        onClick={handleBypass}
      >
        {bypassMutation.isPending ? "Bypassing…" : "Bypass Once"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase row (one row in the vertical stepper)
// ---------------------------------------------------------------------------

function PhaseRow({
  phase,
  phaseIndex,
  totalPhases,
  isExpanded,
  onToggle,
  gateChecks,
  children,
}: {
  phase: {
    key: SdlcPhaseKey;
    label: string;
    status: SdlcLoopStatusCheckStatus;
  };
  phaseIndex: number;
  totalPhases: number;
  isExpanded: boolean;
  onToggle: () => void;
  gateChecks: SdlcLoopStatusCheck[];
  children?: React.ReactNode;
}) {
  const isLast = phaseIndex === totalPhases - 1;
  const colors = getStatusColor(phase.status);
  const hasExpandableContent = gateChecks.length > 0 || !!children;

  return (
    <div className="flex gap-3">
      {/* Vertical timeline */}
      <div className="flex flex-col items-center">
        <PhaseIcon status={phase.status} phaseIndex={phaseIndex} />
        {!isLast && (
          <div
            className={cn(
              "mt-1 w-px flex-1 min-h-[8px]",
              phase.status === "passed" || phase.status === "degraded"
                ? colors.line
                : "bg-border",
            )}
          />
        )}
      </div>

      {/* Content */}
      <div className={cn("min-w-0 flex-1 pb-3", isLast && "pb-0")}>
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-2 text-left",
            hasExpandableContent
              ? "cursor-pointer hover:opacity-80"
              : "cursor-default",
          )}
          onClick={hasExpandableContent ? onToggle : undefined}
          disabled={!hasExpandableContent}
        >
          <span className="text-[13px] font-semibold text-foreground">
            {phase.label}
          </span>
          <span
            className={cn(
              "inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none",
              colors.badge,
            )}
          >
            {getCheckStatusLabel(phase.status)}
          </span>
          {hasExpandableContent && (
            <ChevronDownIcon
              className={cn(
                "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
                isExpanded && "rotate-180",
              )}
            />
          )}
        </button>

        {/* Expanded content */}
        {isExpanded && (
          <div className="mt-1.5 space-y-1.5">
            {gateChecks.length > 0 && (
              <div className="rounded-md border bg-muted/20 px-2.5 py-1.5">
                {gateChecks.map((check) => (
                  <GateDetailRow key={check.key} check={check} />
                ))}
              </div>
            )}
            {children}
          </div>
        )}
      </div>
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
  const [expandedPhases, setExpandedPhases] = useState<Set<SdlcPhaseKey>>(
    new Set(),
  );
  const { data, isLoading, isError } = useDeliveryLoopStatusQuery({
    threadId,
    enabled,
  });
  const sdlcPlanReviewCard = useFeatureFlag("sdlcPlanReviewCard");

  const togglePhase = useCallback((key: SdlcPhaseKey) => {
    setExpandedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

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
          key: SdlcPhaseKey;
          label: string;
          status: SdlcLoopStatusCheckStatus;
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
    data && sdlcPlanReviewCard
      ? buildArtifactFallbackPlanSpecViewModel({
          summary:
            data.artifacts.planningArtifact?.planText ??
            "Structured plan captured for this task.",
          tasks: data.artifacts.plannedTasks.map<PlanTaskViewModel>((task) => ({
            stableTaskId: task.stableTaskId,
            title: task.title,
            description: task.description,
            acceptance: task.acceptance,
          })),
        })
      : null;

  return (
    <div className="w-full border-b border-border/70 bg-gradient-to-b from-background to-muted/20">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-3 px-4 py-3">
        {/* Header row */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Delivery Loop
            </p>
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-foreground">
                {stateLabel}
              </p>
              {explanation && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <InfoIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[280px]">
                    {explanation}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {links?.pullRequestUrl && (
              <a
                href={links.pullRequestUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <GitPullRequestIcon className="size-3" />
                PR
                <ExternalLinkIcon className="size-2.5" />
              </a>
            )}
            <div className="flex min-w-[180px] items-center gap-2 sm:min-w-[260px]">
              <Progress
                value={progressPercent}
                className="h-1.5 flex-1 bg-muted [&>div]:bg-foreground"
              />
              <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                {isLoading ? "--" : `${progressPercent}%`}
              </span>
            </div>
            {needsAttention?.isBlocked ? (
              <Badge variant="destructive" className="text-[11px]">
                {needsAttention.blockerCount} blocker
                {needsAttention.blockerCount === 1 ? "" : "s"}
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[11px]">
                On Track
              </Badge>
            )}
          </div>
        </div>

        {/* Blocker details + intervention controls */}
        {needsAttention?.isBlocked && needsAttention.topBlockers.length > 0 && (
          <BlockerList topBlockers={needsAttention.topBlockers} />
        )}
        {showInterventionControls && data && (
          <SdlcInterventionControls
            threadId={threadId}
            threadChatId={threadChatId}
            canResume={data.actions.canResume}
            canBypassOnce={data.actions.canBypassOnce}
          />
        )}

        {/* Vertical phase stepper */}
        <div className="mt-0.5">
          {phases.map((phase, index) => {
            const phaseChecks = getChecksForPhase(checks, phase.key);

            return (
              <PhaseRow
                key={phase.key}
                phase={phase}
                phaseIndex={index}
                totalPhases={phases.length}
                isExpanded={expandedPhases.has(phase.key)}
                onToggle={() => togglePhase(phase.key)}
                gateChecks={phaseChecks}
              >
                {phase.key === "planning" &&
                  expandedPhases.has("planning") &&
                  data?.artifacts?.plannedTasks && (
                    <>
                      {planCardModel && (
                        <DeliveryLoopPlanReviewCard
                          plan={planCardModel}
                          className="mt-1"
                        />
                      )}
                      <SdlcPlanTaskList
                        tasks={data.artifacts.plannedTasks}
                        taskSummary={data.artifacts.plannedTaskSummary}
                        showApprove={data.actions.canApprovePlan}
                        threadId={threadId}
                        threadChatId={threadChatId}
                      />
                    </>
                  )}
              </PhaseRow>
            );
          })}
        </div>
      </div>
    </div>
  );
}
