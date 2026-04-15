"use client";

import React, { useEffect, useState } from "react";
import { Loader2, Check, Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BootingSubstatus } from "@terragon/shared/delivery-loop/thread-meta-event";
import { useThreadMetaEvents } from "./meta-chips/use-thread-meta-events";

// ----- ordered step definitions -----

type BootStep = {
  substatus: BootingSubstatus;
  label: string;
};

const BOOT_STEPS: BootStep[] = [
  { substatus: "provisioning", label: "Provisioning machine" },
  { substatus: "cloning-repo", label: "Cloning repository" },
  { substatus: "installing-agent", label: "Installing agent" },
  { substatus: "running-setup-script", label: "Configuring environment" },
  { substatus: "booting-done", label: "Waiting for assistant to start" },
];

/**
 * Given the current substatus (from DB/props), return the index of the
 * currently in-progress step.
 */
function currentStepIndex(substatus: BootingSubstatus | null): number {
  if (substatus === null) return 0;
  // `provisioning-done` maps to the same step as `provisioning`
  const normalized: BootingSubstatus =
    substatus === "provisioning-done" ? "provisioning" : substatus;
  const idx = BOOT_STEPS.findIndex((s) => s.substatus === normalized);
  return idx === -1 ? 0 : idx;
}

// ----- duration formatting -----

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}m ${secs}s`;
}

// ----- live elapsed timer -----

/**
 * Ticking elapsed counter for the active step.
 * Isolated in its own component so only this node re-renders on each tick.
 */
function ActiveStepTimer({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const elapsedMs = now - new Date(startedAt).getTime();
  const elapsed = Math.max(0, elapsedMs);

  return (
    <span
      className="font-mono text-xs text-muted-foreground/60 flex-shrink-0 tabular-nums"
      aria-live="polite"
      aria-label={`Running for ${formatDuration(elapsed)}`}
    >
      {formatDuration(elapsed)}
    </span>
  );
}

// ----- install progress bar -----

function InstallProgressBar({
  resolved,
  total,
  currentPackage,
}: {
  resolved: number;
  total?: number;
  currentPackage?: string;
}) {
  const BAR_WIDTH = 20;

  let filled = BAR_WIDTH;

  if (total !== undefined && total > 0) {
    filled = Math.round((resolved / total) * BAR_WIDTH);
    filled = Math.min(filled, BAR_WIDTH);
  } else {
    // Indeterminate: animate with a fixed partial fill
    filled = Math.min(resolved % (BAR_WIDTH + 1), BAR_WIDTH);
  }

  const empty = BAR_WIDTH - filled;
  const filledChars = "━".repeat(filled);
  const emptyChars = "░".repeat(empty);

  return (
    <div className="mt-1 pl-6 flex flex-col gap-0.5">
      <span
        className="font-mono text-xs text-muted-foreground tracking-tight"
        aria-label={
          total !== undefined
            ? `Install progress: ${resolved} of ${total} packages`
            : `Install progress: ${resolved} packages resolved`
        }
      >
        {total === undefined ? (
          // Indeterminate: pulse the filled portion to signal ongoing activity
          <span>
            <span className="animate-pulse">{filledChars}</span>
            {emptyChars}
          </span>
        ) : (
          <span>
            {filledChars}
            {emptyChars}
          </span>
        )}{" "}
        {total !== undefined ? (
          <span>
            {resolved}/{total}
          </span>
        ) : (
          <span>{resolved} resolved</span>
        )}
      </span>
      {currentPackage && (
        <span
          className="text-xs text-muted-foreground/70 truncate max-w-full"
          title={currentPackage}
        >
          Installing {currentPackage}
        </span>
      )}
    </div>
  );
}

// ----- main component -----

export interface BootChecklistProps {
  /** Thread ID used to subscribe to meta events for real-time step updates. */
  threadId: string;
  /**
   * Current substatus from the DB / parent component.
   * Used as a fallback when meta events haven't arrived yet.
   */
  currentSubstatus: BootingSubstatus | null;
}

/**
 * Renders a compact vertical checklist of the 5 sandbox boot steps.
 *
 * - Uses `useThreadMetaEvents` to pick up `boot.substatus_changed` events
 *   for accurate per-step durations.
 * - Falls back to deriving state from `currentSubstatus` if no meta events
 *   have arrived yet (first load or meta events lost in transit).
 * - Shows an install progress bar under the `installing-agent` step while
 *   that step is in-progress.
 */
export function BootChecklist({
  threadId,
  currentSubstatus,
}: BootChecklistProps) {
  const { snapshot } = useThreadMetaEvents(threadId);
  const { bootSteps, installProgress } = snapshot;

  // Determine which step is currently active using meta events when available,
  // falling back to the currentSubstatus prop.
  const hasMetaSteps = bootSteps.length > 0;
  const activeIndex = hasMetaSteps
    ? BOOT_STEPS.findIndex(
        (s) => s.substatus === bootSteps[bootSteps.length - 1]!.substatus,
      )
    : currentStepIndex(currentSubstatus);

  return (
    <div
      className="flex flex-col gap-0 py-0.5"
      role="list"
      aria-label="Boot progress"
    >
      {BOOT_STEPS.map((step, index) => {
        const isCompleted = index < activeIndex;
        const isActive = index === activeIndex;
        const isPending = index > activeIndex;

        // Look up duration from meta event steps if available.
        const metaStep = bootSteps.find((s) => s.substatus === step.substatus);
        const durationMs = metaStep?.durationMs;
        const startedAt = metaStep?.startedAt;

        return (
          <div key={step.substatus} role="listitem">
            <div className="flex items-center gap-2 py-[3px] min-h-[24px]">
              {/* Status icon */}
              <span
                className={cn(
                  "flex-shrink-0 w-4 h-4 flex items-center justify-center",
                  {
                    "text-primary": isCompleted,
                    "text-foreground": isActive,
                    "text-muted-foreground opacity-30": isPending,
                  },
                )}
                aria-hidden
              >
                {isCompleted ? (
                  <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                ) : isActive ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Circle className="w-3 h-3" />
                )}
              </span>

              {/* Step label */}
              <span
                className={cn("flex-1 text-sm", {
                  "text-foreground": isActive,
                  "text-muted-foreground": isCompleted || isPending,
                  "opacity-40": isPending,
                })}
              >
                {step.label}
              </span>

              {/* Duration: static badge for completed steps, live timer for active */}
              {isCompleted && durationMs !== undefined && (
                <span
                  className="font-mono text-xs text-muted-foreground/60 flex-shrink-0 tabular-nums"
                  aria-label={`Completed in ${formatDuration(durationMs)}`}
                >
                  {formatDuration(durationMs)}
                </span>
              )}
              {isActive && startedAt !== undefined && (
                <ActiveStepTimer startedAt={startedAt} />
              )}
            </div>

            {/* Install progress bar — only shown when this step is active */}
            {step.substatus === "installing-agent" &&
              isActive &&
              installProgress !== null && (
                <InstallProgressBar
                  resolved={installProgress.resolved}
                  total={installProgress.total}
                  currentPackage={installProgress.currentPackage}
                />
              )}
          </div>
        );
      })}
    </div>
  );
}
