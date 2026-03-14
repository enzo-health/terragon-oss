import type { EvalMetrics, MetricComparison } from "../types";

type Direction = "lower" | "higher";

const METRIC_DEFS: {
  key: keyof EvalMetrics;
  label: string;
  direction: Direction;
}[] = [
  { key: "fixCycles", label: "Fix Cycles", direction: "lower" },
  { key: "totalDurationMs", label: "Total Duration (s)", direction: "lower" },
  { key: "blockingFindings", label: "Blocking Findings", direction: "lower" },
  {
    key: "signalToNoiseRatio",
    label: "Signal/Noise Ratio",
    direction: "higher",
  },
  { key: "convergenceRate", label: "Convergence Rate", direction: "higher" },
  { key: "totalFindings", label: "Total Findings", direction: "lower" },
  { key: "uniqueRootCauses", label: "Unique Root Causes", direction: "lower" },
  {
    key: "crossReviewerDuplicates",
    label: "Cross-Reviewer Dupes",
    direction: "lower",
  },
  {
    key: "maxFixCyclesBeforeBlock",
    label: "Max Fix Before Block",
    direction: "lower",
  },
  { key: "totalSignals", label: "Total Signals", direction: "lower" },
];

/**
 * Compare current metrics against baseline, computing deltas and improvement status.
 */
export function compareMetrics(
  baseline: EvalMetrics,
  current: EvalMetrics,
): MetricComparison[] {
  const comparisons: MetricComparison[] = [];

  for (const def of METRIC_DEFS) {
    const bVal = baseline[def.key];
    const cVal = current[def.key];

    if (typeof bVal === "number" && typeof cVal === "number") {
      const delta = computeDelta(bVal, cVal);
      const improved = determineImprovement(bVal, cVal, def.direction);

      comparisons.push({
        metric: def.label,
        baseline:
          def.key === "totalDurationMs" ? Math.round(bVal / 1000) : round(bVal),
        current:
          def.key === "totalDurationMs" ? Math.round(cVal / 1000) : round(cVal),
        delta,
        improved,
      });
    }
  }

  // Final state (string comparison)
  comparisons.push({
    metric: "Final State",
    baseline: baseline.finalState,
    current: current.finalState,
    delta: baseline.finalState === current.finalState ? "-" : "changed",
    improved: current.succeeded
      ? true
      : baseline.succeeded === current.succeeded
        ? null
        : false,
  });

  return comparisons;
}

function computeDelta(baseline: number, current: number): string {
  if (baseline === 0 && current === 0) return "-";
  if (baseline === 0) return current > 0 ? "+inf" : "-inf";
  const pct = ((current - baseline) / Math.abs(baseline)) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${Math.round(pct)}%`;
}

function determineImprovement(
  baseline: number,
  current: number,
  direction: Direction,
): boolean | null {
  if (baseline === current) return null;
  if (direction === "lower") return current < baseline;
  return current > baseline;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
