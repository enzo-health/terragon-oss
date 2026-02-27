"use client";

import type {
  SdlcLoopStatusCheck,
  SdlcLoopStatusCheckStatus,
} from "@/lib/sdlc-loop-status";
import { cn } from "@/lib/utils";
import { useSdlcLoopStatusQuery } from "@/queries/sdlc-loop-status-queries";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from "@/components/reui/stepper";
import { AlertTriangleIcon, CheckIcon, LoaderCircleIcon } from "lucide-react";

type SdlcPhaseKey =
  | "planning"
  | "implementing"
  | "reviewing"
  | "ci"
  | "ui_testing";

type SdlcPhase = {
  key: SdlcPhaseKey;
  label: string;
  status: SdlcLoopStatusCheckStatus;
};

const SDLC_PHASE_LABELS: Record<SdlcPhaseKey, string> = {
  planning: "Planning",
  implementing: "Implementing",
  reviewing: "Reviewing",
  ci: "CI",
  ui_testing: "UI Testing",
};

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

function aggregateCheckStatuses(
  statuses: readonly SdlcLoopStatusCheckStatus[],
): SdlcLoopStatusCheckStatus {
  if (statuses.length === 0) {
    return "not_started";
  }
  if (statuses.some((status) => status === "blocked")) {
    return "blocked";
  }
  if (statuses.some((status) => status === "pending")) {
    return "pending";
  }
  const hasNotStarted = statuses.some((status) => status === "not_started");
  const hasPassedLike = statuses.some(
    (status) => status === "passed" || status === "degraded",
  );
  if (hasNotStarted && hasPassedLike) {
    return "pending";
  }
  if (hasNotStarted) {
    return "not_started";
  }
  if (statuses.some((status) => status === "degraded")) {
    return "degraded";
  }
  if (statuses.every((status) => status === "passed")) {
    return "passed";
  }
  return "pending";
}

function getPlanningStatus({
  state,
  isLoading,
}: {
  state: string | undefined;
  isLoading: boolean;
}): SdlcLoopStatusCheckStatus {
  if (!state) {
    return isLoading ? "pending" : "not_started";
  }
  if (state === "enrolled") {
    return "pending";
  }
  return "passed";
}

function getImplementingStatus({
  state,
  isLoading,
}: {
  state: string | undefined;
  isLoading: boolean;
}): SdlcLoopStatusCheckStatus {
  if (!state) {
    return isLoading ? "pending" : "not_started";
  }
  if (state === "enrolled") {
    return "not_started";
  }
  if (state === "implementing" || state === "gates_running") {
    return "pending";
  }
  if (state === "blocked_on_agent_fixes") {
    return "blocked";
  }
  if (state === "stopped" || state === "terminated_pr_closed") {
    return "degraded";
  }
  return "passed";
}

function getCurrentStep(phases: readonly SdlcPhase[]): number {
  const firstIncompleteIndex = phases.findIndex(
    (phase) => phase.status !== "passed" && phase.status !== "degraded",
  );
  return firstIncompleteIndex === -1 ? phases.length : firstIncompleteIndex + 1;
}

function getCheckStatusOrDefault({
  checks,
  key,
  isLoading,
}: {
  checks: readonly SdlcLoopStatusCheck[];
  key: SdlcLoopStatusCheck["key"];
  isLoading: boolean;
}): SdlcLoopStatusCheckStatus {
  const value = checks.find((check) => check.key === key)?.status;
  if (value) {
    return value;
  }
  return isLoading ? "pending" : "not_started";
}

function buildSdlcPhases({
  state,
  checks,
  isLoading,
}: {
  state: string | undefined;
  checks: readonly SdlcLoopStatusCheck[];
  isLoading: boolean;
}): SdlcPhase[] {
  const planningStatus = getPlanningStatus({ state, isLoading });
  const implementingStatus = getImplementingStatus({ state, isLoading });
  const reviewingStatus = aggregateCheckStatuses([
    getCheckStatusOrDefault({ checks, key: "review_threads", isLoading }),
    getCheckStatusOrDefault({ checks, key: "deep_review", isLoading }),
    getCheckStatusOrDefault({
      checks,
      key: "architecture_carmack",
      isLoading,
    }),
  ]);
  const ciStatus = getCheckStatusOrDefault({ checks, key: "ci", isLoading });
  const uiTestingStatus = getCheckStatusOrDefault({
    checks,
    key: "video",
    isLoading,
  });

  return [
    {
      key: "planning",
      label: SDLC_PHASE_LABELS.planning,
      status: planningStatus,
    },
    {
      key: "implementing",
      label: SDLC_PHASE_LABELS.implementing,
      status: implementingStatus,
    },
    {
      key: "reviewing",
      label: SDLC_PHASE_LABELS.reviewing,
      status: reviewingStatus,
    },
    { key: "ci", label: SDLC_PHASE_LABELS.ci, status: ciStatus },
    {
      key: "ui_testing",
      label: SDLC_PHASE_LABELS.ui_testing,
      status: uiTestingStatus,
    },
  ];
}

export function SdlcTopProgressStepper({
  threadId,
  enabled,
}: {
  threadId: string;
  enabled: boolean;
}) {
  const { data, isLoading, isError } = useSdlcLoopStatusQuery({
    threadId,
    enabled,
  });

  if (!enabled || isError) {
    return null;
  }

  const phases = buildSdlcPhases({
    state: data?.state,
    checks: data?.checks ?? [],
    isLoading,
  });
  const currentStep = getCurrentStep(phases);
  const progressPercent = data?.progressPercent ?? 0;
  const stateLabel = data?.stateLabel ?? "Waiting to Start";
  const needsAttention = data?.needsAttention.isBlocked ?? false;
  const blockerCount = data?.needsAttention.blockerCount ?? 0;

  return (
    <div className="w-full border-b border-border/70 bg-background">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              SDLC Loop
            </p>
            <p className="truncate text-sm font-semibold text-foreground">
              {stateLabel}
            </p>
          </div>
          <div className="ml-auto flex min-w-[220px] items-center gap-2 sm:min-w-[280px]">
            <Progress
              value={progressPercent}
              className="h-1.5 flex-1 bg-muted/70 [&>div]:bg-foreground"
            />
            <span className="text-xs font-semibold tabular-nums text-muted-foreground">
              {isLoading ? "--" : `${progressPercent}%`}
            </span>
            {needsAttention ? (
              <Badge variant="destructive" className="text-[11px]">
                {blockerCount} blocker{blockerCount === 1 ? "" : "s"}
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[11px]">
                On Track
              </Badge>
            )}
          </div>
        </div>

        <Stepper
          value={currentStep}
          indicators={{
            completed: <CheckIcon className="size-3.5" />,
            loading: <LoaderCircleIcon className="size-3.5 animate-spin" />,
          }}
          className="w-full"
        >
          <StepperNav className="gap-2">
            {phases.map((phase, index) => {
              const isStepDone =
                phase.status === "passed" || phase.status === "degraded";
              const isStepBlocked = phase.status === "blocked";
              const isStepLoading = phase.status === "pending";
              return (
                <StepperItem
                  key={phase.key}
                  step={index + 1}
                  completed={isStepDone}
                  loading={isStepLoading}
                  className="relative min-w-0 flex-1 items-start"
                >
                  <StepperTrigger className="flex grow min-w-0" asChild>
                    <div className="flex min-w-0 items-center gap-2">
                      <StepperIndicator
                        className={cn(
                          "size-7 border text-[10px] font-semibold data-[state=inactive]:border-border data-[state=inactive]:bg-background data-[state=inactive]:text-muted-foreground",
                          isStepDone
                            ? "data-[state=completed]:border-emerald-600 data-[state=completed]:bg-emerald-600 data-[state=completed]:text-white"
                            : "",
                          isStepBlocked
                            ? "data-[state=active]:border-destructive data-[state=active]:bg-destructive data-[state=active]:text-white"
                            : "data-[state=active]:border-foreground data-[state=active]:bg-foreground data-[state=active]:text-background",
                        )}
                      >
                        {isStepBlocked ? (
                          <AlertTriangleIcon className="size-3.5" />
                        ) : (
                          index + 1
                        )}
                      </StepperIndicator>
                      <div className="min-w-0">
                        <StepperTitle className="truncate text-[12px] leading-tight">
                          {phase.label}
                        </StepperTitle>
                        <p className="truncate text-[10px] text-muted-foreground">
                          {getCheckStatusLabel(phase.status)}
                        </p>
                      </div>
                    </div>
                  </StepperTrigger>

                  {phases.length > index + 1 && (
                    <StepperSeparator
                      className={cn(
                        "absolute inset-x-0 start-7 top-3.5 m-0 h-px group-data-[orientation=horizontal]/stepper-nav:w-[calc(100%-1.75rem)] group-data-[orientation=horizontal]/stepper-nav:flex-none",
                        isStepDone ? "bg-emerald-600" : "bg-border",
                      )}
                    />
                  )}
                </StepperItem>
              );
            })}
          </StepperNav>
        </Stepper>
      </div>
    </div>
  );
}
