import type {
  EvalRun,
  EvalMetrics,
  StateTransition,
  EvalFinding,
} from "../types";

/**
 * Compute EvalMetrics from an EvalRun's state trace and findings.
 */
export function computeMetrics(run: EvalRun): EvalMetrics {
  const { stateTrace, findings } = run;

  // Fix cycles: transitions where nextState goes from review_gate -> implementing via review_blocked
  const fixCycles = countFixCycles(stateTrace);

  // Convergence rate: 1 / (1 + fixCycles)
  const convergenceRate = 1 / (1 + fixCycles);

  // Duration: last timestamp - first timestamp
  const totalDurationMs = computeDurationMs(stateTrace);

  // Max fix attempt count at last transition
  const maxFixCyclesBeforeBlock =
    stateTrace.length > 0
      ? stateTrace[stateTrace.length - 1]!.fixAttemptCount
      : 0;

  // Finding metrics
  const allFindings = [...(findings.deep ?? []), ...(findings.carmack ?? [])];
  const totalFindings = allFindings.length;
  const blockingFindings = allFindings.filter((f) => f.isBlocking).length;

  const rootCauses = new Set(allFindings.map((f) => f.stableFindingId));
  const uniqueRootCauses = rootCauses.size;

  const signalToNoiseRatio =
    totalFindings > 0 ? uniqueRootCauses / totalFindings : 1;

  const crossReviewerDuplicates = countCrossReviewerDuplicates(
    findings.deep ?? [],
    findings.carmack ?? [],
  );

  // Final state
  const finalState =
    stateTrace.length > 0
      ? stateTrace[stateTrace.length - 1]!.nextState
      : "unknown";
  const succeeded = finalState === "completed" || finalState === "merged";

  return {
    totalSignals: stateTrace.length,
    fixCycles,
    maxFixCyclesBeforeBlock,
    totalDurationMs,
    convergenceRate,
    totalFindings,
    blockingFindings,
    uniqueRootCauses,
    signalToNoiseRatio,
    crossReviewerDuplicates,
    finalState,
    succeeded,
  };
}

function countFixCycles(trace: StateTransition[]): number {
  let count = 0;
  for (const t of trace) {
    if (t.nextState === "implementing" && t.event === "review_blocked") {
      count++;
    }
  }
  return count;
}

function computeDurationMs(trace: StateTransition[]): number {
  if (trace.length < 2) return 0;
  const first = new Date(trace[0]!.timestamp).getTime();
  const last = new Date(trace[trace.length - 1]!.timestamp).getTime();
  const duration = last - first;
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

function countCrossReviewerDuplicates(
  deep: EvalFinding[],
  carmack: EvalFinding[],
): number {
  const deepIds = new Set(deep.map((f) => f.stableFindingId));
  let dupes = 0;
  for (const f of carmack) {
    if (deepIds.has(f.stableFindingId)) dupes++;
  }
  return dupes;
}
