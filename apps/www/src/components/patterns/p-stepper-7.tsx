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
import type { SdlcLoopState } from "@terragon/shared/db/types";
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

type SdlcCheckStatusMap = Partial<
  Record<SdlcLoopStatusCheck["key"], SdlcLoopStatusCheckStatus>
>;

const SDLC_PHASE_LABELS: Record<SdlcPhaseKey, string> = {
  planning: "Planning",
  implementing: "Implementing",
  reviewing: "Reviewing",
  ci: "CI",
  ui_testing: "UI Testing",
};

const REVIEW_CHECK_KEYS: readonly SdlcLoopStatusCheck["key"][] = [
  "review_threads",
  "deep_review",
  "architecture_carmack",
];

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

function getStatusBadgeClass(status: SdlcLoopStatusCheckStatus): string {
  switch (status) {
    case "passed":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "blocked":
      return "border-red-200 bg-red-50 text-red-700";
    case "degraded":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "not_started":
      return "border-border bg-muted text-muted-foreground";
    default:
      return "border-sky-200 bg-sky-50 text-sky-700";
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

function getCheckStatusOrDefault({
  checkStatuses,
  key,
  isLoading,
}: {
  checkStatuses: SdlcCheckStatusMap;
  key: SdlcLoopStatusCheck["key"];
  isLoading: boolean;
}): SdlcLoopStatusCheckStatus {
  const status = checkStatuses[key];
  if (status) {
    return status;
  }
  return isLoading ? "pending" : "not_started";
}

function buildCheckStatusMap(
  checks: readonly SdlcLoopStatusCheck[],
): SdlcCheckStatusMap {
  const result: SdlcCheckStatusMap = {};
  for (const check of checks) {
    result[check.key] = check.status;
  }
  return result;
}

function getPlanningStatus({
  state,
  isLoading,
}: {
  state: SdlcLoopState | undefined;
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
  state: SdlcLoopState | undefined;
  isLoading: boolean;
}): SdlcLoopStatusCheckStatus {
  if (!state) {
    return isLoading ? "pending" : "not_started";
  }

  switch (state) {
    case "enrolled":
      return "not_started";
    case "implementing":
    case "blocked_on_agent_fixes":
      return "pending";
    case "terminated_pr_closed":
    case "stopped":
      return "degraded";
    default:
      return "passed";
  }
}

function getReviewingStatus({
  state,
  checkStatuses,
  isLoading,
}: {
  state: SdlcLoopState | undefined;
  checkStatuses: SdlcCheckStatusMap;
  isLoading: boolean;
}): SdlcLoopStatusCheckStatus {
  if (!state) {
    return isLoading ? "pending" : "not_started";
  }

  if (state === "enrolled" || state === "implementing") {
    return "not_started";
  }

  if (state === "terminated_pr_closed" || state === "stopped") {
    return "degraded";
  }

  if (
    state === "blocked_on_review_threads" ||
    state === "blocked_on_agent_fixes" ||
    state === "blocked_on_human_feedback"
  ) {
    return "blocked";
  }

  if (
    state === "video_pending" ||
    state === "human_review_ready" ||
    state === "video_degraded_ready" ||
    state === "done" ||
    state === "terminated_pr_merged"
  ) {
    return "passed";
  }

  const aggregateStatus = aggregateCheckStatuses(
    REVIEW_CHECK_KEYS.map((key) =>
      getCheckStatusOrDefault({
        checkStatuses,
        key,
        isLoading,
      }),
    ),
  );

  if (
    aggregateStatus === "not_started" &&
    (state === "gates_running" || state === "blocked_on_ci")
  ) {
    return "pending";
  }

  return aggregateStatus;
}

function getCiStatus({
  state,
  checkStatuses,
  isLoading,
}: {
  state: SdlcLoopState | undefined;
  checkStatuses: SdlcCheckStatusMap;
  isLoading: boolean;
}): SdlcLoopStatusCheckStatus {
  if (!state) {
    return isLoading ? "pending" : "not_started";
  }

  if (state === "enrolled" || state === "implementing") {
    return "not_started";
  }

  if (state === "blocked_on_ci") {
    return "blocked";
  }

  if (state === "terminated_pr_closed" || state === "stopped") {
    return "degraded";
  }

  const ciStatus = getCheckStatusOrDefault({
    checkStatuses,
    key: "ci",
    isLoading,
  });

  if (
    ciStatus === "not_started" &&
    (state === "gates_running" ||
      state === "blocked_on_review_threads" ||
      state === "blocked_on_agent_fixes")
  ) {
    return "pending";
  }

  return ciStatus;
}

function getUiTestingStatus({
  state,
  checkStatuses,
  isLoading,
}: {
  state: SdlcLoopState | undefined;
  checkStatuses: SdlcCheckStatusMap;
  isLoading: boolean;
}): SdlcLoopStatusCheckStatus {
  if (!state) {
    return isLoading ? "pending" : "not_started";
  }

  if (
    state === "enrolled" ||
    state === "implementing" ||
    state === "gates_running" ||
    state === "blocked_on_agent_fixes" ||
    state === "blocked_on_ci" ||
    state === "blocked_on_review_threads"
  ) {
    return "not_started";
  }

  if (state === "video_pending") {
    return "pending";
  }

  if (state === "video_degraded_ready") {
    return "degraded";
  }

  if (state === "terminated_pr_closed" || state === "stopped") {
    return "degraded";
  }

  const videoStatus = getCheckStatusOrDefault({
    checkStatuses,
    key: "video",
    isLoading,
  });

  if (
    state === "human_review_ready" ||
    state === "done" ||
    state === "terminated_pr_merged"
  ) {
    if (videoStatus === "blocked" || videoStatus === "degraded") {
      return "degraded";
    }
    if (videoStatus === "pending") {
      return "pending";
    }
    return "passed";
  }

  if (state === "blocked_on_human_feedback") {
    if (videoStatus === "blocked") {
      return "degraded";
    }
    if (videoStatus === "degraded" || videoStatus === "passed") {
      return videoStatus;
    }
    return "pending";
  }

  return videoStatus;
}

function getCurrentStep(phases: readonly SdlcPhase[]): number {
  const blockedIndex = phases.findIndex((phase) => phase.status === "blocked");
  if (blockedIndex >= 0) {
    return blockedIndex + 1;
  }

  const firstIncompleteIndex = phases.findIndex(
    (phase) => phase.status !== "passed" && phase.status !== "degraded",
  );
  return firstIncompleteIndex === -1 ? phases.length : firstIncompleteIndex + 1;
}

function buildSdlcPhases({
  state,
  checks,
  isLoading,
}: {
  state: SdlcLoopState | undefined;
  checks: readonly SdlcLoopStatusCheck[];
  isLoading: boolean;
}): SdlcPhase[] {
  const checkStatuses = buildCheckStatusMap(checks);

  return [
    {
      key: "planning",
      label: SDLC_PHASE_LABELS.planning,
      status: getPlanningStatus({ state, isLoading }),
    },
    {
      key: "implementing",
      label: SDLC_PHASE_LABELS.implementing,
      status: getImplementingStatus({ state, isLoading }),
    },
    {
      key: "reviewing",
      label: SDLC_PHASE_LABELS.reviewing,
      status: getReviewingStatus({ state, checkStatuses, isLoading }),
    },
    {
      key: "ci",
      label: SDLC_PHASE_LABELS.ci,
      status: getCiStatus({ state, checkStatuses, isLoading }),
    },
    {
      key: "ui_testing",
      label: SDLC_PHASE_LABELS.ui_testing,
      status: getUiTestingStatus({ state, checkStatuses, isLoading }),
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
    <div className="w-full border-b border-border/70 bg-gradient-to-b from-background to-muted/20">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              SDLC Loop
            </p>
            <p className="truncate text-sm font-semibold text-foreground">
              {stateLabel}
            </p>
          </div>

          <div className="ml-auto flex min-w-[220px] items-center gap-2 sm:min-w-[300px]">
            <Progress
              value={progressPercent}
              className="h-1.5 flex-1 bg-muted [&>div]:bg-foreground"
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
          <StepperNav className="gap-3 overflow-x-auto pb-1">
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
                  className="min-w-[150px] items-start"
                >
                  <StepperTrigger
                    disabled
                    className="h-auto cursor-default items-start gap-2 rounded-lg px-1 py-1 disabled:opacity-100"
                  >
                    <StepperIndicator
                      className={cn(
                        "size-8 border text-[11px] font-semibold",
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

                    <div className="min-w-0 space-y-1 text-left">
                      <StepperTitle className="truncate text-[13px] leading-tight">
                        {phase.label}
                      </StepperTitle>
                      <span
                        className={cn(
                          "inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none",
                          getStatusBadgeClass(phase.status),
                        )}
                      >
                        {getCheckStatusLabel(phase.status)}
                      </span>
                    </div>
                  </StepperTrigger>

                  {phases.length > index + 1 ? (
                    <StepperSeparator
                      className={cn(
                        "mx-2",
                        isStepDone ? "bg-emerald-600" : "bg-border",
                      )}
                    />
                  ) : null}
                </StepperItem>
              );
            })}
          </StepperNav>
        </Stepper>
      </div>
    </div>
  );
}
