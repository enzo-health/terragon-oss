"use client";

import { cn } from "@/lib/utils";
import { CheckIcon, LoaderIcon } from "lucide-react";
import type { ReviewPhase } from "@/types/review";

interface PipelineStep {
  label: string;
  sublabel?: string;
  status: "complete" | "in-progress" | "pending" | "hidden";
}

function getPhaseIndex(phase: ReviewPhase): number {
  const order: ReviewPhase[] = [
    "ai_reviewing",
    "waiting_human",
    "posting",
    "await_author_fixes",
    "re_reviewing",
    "complete",
  ];
  return order.indexOf(phase);
}

function buildSteps(
  phase: ReviewPhase,
  reviewRound: number,
  hasChangesRequested: boolean,
): PipelineStep[] {
  const idx = getPhaseIndex(phase);

  const steps: PipelineStep[] = [
    {
      label: "Pre-review Check",
      status: "complete",
    },
    {
      label: "AI Code Review",
      status:
        phase === "ai_reviewing"
          ? "in-progress"
          : idx > 0
            ? "complete"
            : "pending",
    },
    {
      label: "Human Review",
      sublabel: reviewRound > 1 ? `Round ${reviewRound}` : undefined,
      status:
        phase === "waiting_human"
          ? "in-progress"
          : idx > 1
            ? "complete"
            : "pending",
    },
    {
      label: "Posted",
      status:
        phase === "posting" ? "in-progress" : idx > 2 ? "complete" : "pending",
    },
  ];

  if (hasChangesRequested) {
    steps.push({
      label: "Await Author Fixes",
      status:
        phase === "await_author_fixes"
          ? "in-progress"
          : idx > 3
            ? "complete"
            : "pending",
    });
  }

  if (reviewRound > 1 || phase === "re_reviewing") {
    steps.push({
      label: "Re-Review",
      status:
        phase === "re_reviewing"
          ? "in-progress"
          : phase === "complete" && reviewRound > 1
            ? "complete"
            : "pending",
    });
  }

  return steps.filter((s) => s.status !== "hidden");
}

function StatusIcon({ status }: { status: PipelineStep["status"] }) {
  if (status === "complete") {
    return (
      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
        <CheckIcon className="h-3.5 w-3.5" />
      </div>
    );
  }
  if (status === "in-progress") {
    return (
      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-500/20 text-blue-400">
        <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
      </div>
    );
  }
  return (
    <div className="flex h-6 w-6 items-center justify-center rounded-full border border-muted-foreground/30">
      <div className="h-2 w-2 rounded-full bg-muted-foreground/30" />
    </div>
  );
}

interface ReviewPipelineTimelineProps {
  phase: ReviewPhase;
  reviewRound: number;
  hasChangesRequested: boolean;
}

export function ReviewPipelineTimeline({
  phase,
  reviewRound,
  hasChangesRequested,
}: ReviewPipelineTimelineProps) {
  const steps = buildSteps(phase, reviewRound, hasChangesRequested);

  return (
    <div className="flex flex-col gap-0 py-4 px-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4 px-1">
        Pipeline
      </h3>
      <div className="flex flex-col gap-0">
        {steps.map((step, i) => (
          <div key={step.label} className="flex gap-3 items-start relative">
            {/* Vertical connector line */}
            {i < steps.length - 1 && (
              <div
                className={cn(
                  "absolute left-3 top-6 w-px h-full",
                  step.status === "complete"
                    ? "bg-emerald-500/30"
                    : "bg-muted-foreground/15",
                )}
              />
            )}
            <StatusIcon status={step.status} />
            <div className="flex flex-col pb-6 min-w-0">
              <span
                className={cn(
                  "text-sm font-medium leading-6",
                  step.status === "in-progress"
                    ? "text-foreground"
                    : step.status === "complete"
                      ? "text-muted-foreground"
                      : "text-muted-foreground/60",
                )}
              >
                {step.label}
              </span>
              {step.sublabel && (
                <span className="text-xs text-muted-foreground/60">
                  {step.sublabel}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
