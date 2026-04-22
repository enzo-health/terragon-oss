"use client";

import type { BootingSubstatus } from "@terragon/shared/delivery-loop/thread-meta-event";
import { Check, Loader2 } from "lucide-react";
import React, { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
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
 * `provisioning-done` maps to the same UI row as `provisioning` — both
 * represent the "still in the provisioning phase" window. Used on BOTH
 * the meta-events path and the fallback path so an unmapped substatus
 * never sends activeIndex to -1 (which would mark every step pending).
 */
function normalizeBootSubstatus(substatus: BootingSubstatus): BootingSubstatus {
  return substatus === "provisioning-done" ? "provisioning" : substatus;
}

/**
 * Given the current substatus (from DB/props), return the index of the
 * currently in-progress step.
 */
function currentStepIndex(substatus: BootingSubstatus | null): number {
  if (substatus === null) return 0;
  const idx = BOOT_STEPS.findIndex(
    (s) => s.substatus === normalizeBootSubstatus(substatus),
  );
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
      className="font-mono text-[11px] text-muted-foreground/70 flex-shrink-0 tabular-nums"
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
    <div className="mt-1 mb-1.5 pl-[26px] flex flex-col gap-0.5">
      <span
        className="font-mono text-[11px] tracking-tight tabular-nums"
        aria-label={
          total !== undefined
            ? `Install progress: ${resolved} of ${total} packages`
            : `Install progress: ${resolved} packages resolved`
        }
      >
        {total === undefined ? (
          // Indeterminate: pulse the filled portion to signal ongoing activity
          <span>
            <span className="animate-pulse text-primary/70">{filledChars}</span>
            <span className="text-muted-foreground/60">{emptyChars}</span>
          </span>
        ) : (
          <span>
            <span className="text-primary/70">{filledChars}</span>
            <span className="text-muted-foreground/60">{emptyChars}</span>
          </span>
        )}{" "}
        {total !== undefined ? (
          <span className="text-muted-foreground/80">
            {resolved}/{total}
          </span>
        ) : (
          <span className="text-muted-foreground/80">{resolved} resolved</span>
        )}
      </span>
      {currentPackage && (
        <span
          className="text-[11px] text-muted-foreground/60 truncate max-w-full"
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
  // Normalize the latest meta-events substatus before the lookup so an
  // `provisioning-done` event doesn't send activeIndex to -1 (which would
  // mark every step pending). Mirrors the fallback path.
  const rawLatest = hasMetaSteps
    ? bootSteps[bootSteps.length - 1]!.substatus
    : null;
  const activeIndex = hasMetaSteps
    ? (() => {
        const idx = BOOT_STEPS.findIndex(
          (s) => s.substatus === normalizeBootSubstatus(rawLatest!),
        );
        return idx === -1 ? 0 : idx;
      })()
    : currentStepIndex(currentSubstatus);

  return (
    <div
      className="relative flex flex-col py-1"
      role="list"
      aria-label="Boot progress"
    >
      {/* Timeline rail connecting the step icons. Sits behind the
          icon chips; icons use z-10 + bg-background to "mask" it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-2 top-4 bottom-4 w-px bg-border"
      />
      {BOOT_STEPS.map((step, index) => {
        const isCompleted = index < activeIndex;
        const isActive = index === activeIndex;
        const isPending = index > activeIndex;

        // Look up duration from meta event steps if available.
        const metaStep = bootSteps.find((s) => s.substatus === step.substatus);
        const durationMs = metaStep?.durationMs;
        const startedAt = metaStep?.startedAt;

        return (
          <div key={step.substatus} role="listitem" className="relative">
            <div className="flex items-center gap-2.5 py-1 min-h-[26px]">
              {/* Status icon (chip over the rail) */}
              <span
                className={cn(
                  "relative z-10 flex-shrink-0 w-4 h-4 flex items-center justify-center rounded-full bg-background transition-colors duration-200",
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
                  <span className="w-1.5 h-1.5 rounded-full bg-current" />
                )}
              </span>

              {/* Step label */}
              <span
                className={cn("flex-1 text-sm transition-colors duration-200", {
                  "text-foreground font-medium": isActive,
                  "text-muted-foreground": isCompleted,
                  "text-muted-foreground opacity-40": isPending,
                })}
              >
                {step.label}
              </span>

              {/* Duration: static badge for completed steps, live timer for active */}
              {isCompleted && durationMs !== undefined && (
                <span
                  className="font-mono text-[11px] text-muted-foreground/70 flex-shrink-0 tabular-nums"
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
            {(step.substatus === "installing-agent" ||
              step.substatus === "running-setup-script") &&
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
