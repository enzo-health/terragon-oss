"use client";

import type {
  SdlcLoopStatusCheck,
  SdlcLoopStatusCheckStatus,
} from "@/lib/sdlc-loop-status";
import { cn } from "@/lib/utils";
import { useSdlcLoopStatusQuery } from "@/queries/sdlc-loop-status-queries";
import type { BadgeProps } from "@/components/reui/badge";
import { Badge } from "@/components/reui/badge";
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from "@/components/reui/stepper";
import { CheckIcon, LoaderCircleIcon } from "lucide-react";

const FALLBACK_CHECKS: SdlcLoopStatusCheck[] = [
  {
    key: "ci",
    label: "CI",
    status: "not_started",
    detail: "Waiting for CI evaluation.",
  },
  {
    key: "review_threads",
    label: "Review Threads",
    status: "not_started",
    detail: "Waiting for review thread evaluation.",
  },
  {
    key: "deep_review",
    label: "Deep Review",
    status: "not_started",
    detail: "Waiting for deep review.",
  },
  {
    key: "architecture_carmack",
    label: "Architecture",
    status: "not_started",
    detail: "Waiting for architecture review.",
  },
  {
    key: "video",
    label: "Video",
    status: "not_started",
    detail: "Waiting for artifact capture.",
  },
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
      return "Pending";
  }
}

function getCheckStatusBadgeVariant(
  status: SdlcLoopStatusCheckStatus,
): BadgeProps["variant"] {
  switch (status) {
    case "passed":
      return "success-light";
    case "blocked":
      return "destructive-light";
    case "degraded":
      return "warning-light";
    default:
      return "secondary";
  }
}

function getCurrentStep(checks: readonly SdlcLoopStatusCheck[]): number {
  const firstIncompleteIndex = checks.findIndex(
    (check) => check.status !== "passed" && check.status !== "degraded",
  );
  return firstIncompleteIndex === -1 ? checks.length : firstIncompleteIndex + 1;
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

  const checks = data?.checks ?? FALLBACK_CHECKS;
  const currentStep = getCurrentStep(checks);
  const progressPercent = data?.progressPercent ?? 0;
  const stateLabel = data?.stateLabel ?? "Waiting to Start";
  const needsAttention = data?.needsAttention.isBlocked ?? false;
  const blockerCount = data?.needsAttention.blockerCount ?? 0;

  return (
    <div className="w-full border-b border-border/70 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex w-full max-w-[800px] flex-col gap-2 px-4 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              SDLC Loop
            </p>
            <p className="truncate text-xs font-medium">{stateLabel}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" size="sm">
              {isLoading ? "..." : `${progressPercent}%`}
            </Badge>
            {needsAttention ? (
              <Badge variant="destructive-light" size="sm">
                {blockerCount} blocker{blockerCount === 1 ? "" : "s"}
              </Badge>
            ) : (
              <Badge variant="success-light" size="sm">
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
          <StepperNav className="gap-1 sm:gap-2">
            {checks.map((check, index) => {
              const isStepDone =
                check.status === "passed" || check.status === "degraded";
              return (
                <StepperItem
                  key={check.key}
                  step={index + 1}
                  completed={isStepDone}
                  className="relative min-w-0 flex-1 items-start"
                >
                  <StepperTrigger
                    className="flex grow items-center gap-2 min-w-0"
                    asChild
                  >
                    <>
                      <StepperIndicator
                        className={cn(
                          "size-6 border text-[10px] font-semibold data-[state=inactive]:border-border data-[state=inactive]:bg-transparent data-[state=inactive]:text-muted-foreground",
                          check.status === "blocked"
                            ? "data-[state=active]:border-destructive data-[state=active]:bg-destructive data-[state=active]:text-white"
                            : "",
                        )}
                      >
                        {index + 1}
                      </StepperIndicator>
                      <div className="hidden min-w-0 flex-col items-start gap-0.5 sm:flex">
                        <StepperTitle className="truncate text-[11px] leading-tight">
                          {check.label}
                        </StepperTitle>
                        <Badge
                          variant={getCheckStatusBadgeVariant(check.status)}
                          size="xs"
                        >
                          {getCheckStatusLabel(check.status)}
                        </Badge>
                      </div>
                    </>
                  </StepperTrigger>

                  {checks.length > index + 1 && (
                    <StepperSeparator
                      className={cn(
                        "absolute inset-x-0 start-6 top-3 m-0 group-data-[orientation=horizontal]/stepper-nav:w-[calc(100%-1.5rem)] group-data-[orientation=horizontal]/stepper-nav:flex-none",
                        isStepDone ? "bg-success" : "",
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
