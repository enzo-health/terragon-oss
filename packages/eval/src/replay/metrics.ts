/**
 * Compute EvalMetrics from a completed replay's state trace.
 */

import type { EvalMetrics, StateTransition } from "../types";
import type { SignalReplayResult } from "./signal-processor";

const FIX_TRANSITION_EVENTS = new Set([
  "review_blocked",
  "ci_gate_blocked",
  "deep_review_gate_blocked",
  "carmack_review_gate_blocked",
  "babysit_blocked",
  "implementation_gate_blocked",
]);

export function computeMetrics({
  results,
  trace,
  totalDurationMs,
}: {
  results: SignalReplayResult[];
  trace: StateTransition[];
  totalDurationMs: number;
}): EvalMetrics {
  const totalSignals = results.length;

  // Fix cycles = transitions that go back to implementing from a gate
  const fixCycles = trace.filter(
    (t) =>
      FIX_TRANSITION_EVENTS.has(t.event) ||
      (t.nextState === "implementing" && t.previousState !== "planning"),
  ).length;

  const maxFixCyclesBeforeBlock = Math.max(
    0,
    ...results.map((r) => r.fixAttemptCount),
  );

  // convergenceRate: 1.0 = no rework, lower = more fix cycles
  const convergenceRate =
    totalSignals > 0 ? Math.max(0, 1 - fixCycles / totalSignals) : 1;

  const finalState =
    trace.length > 0 ? trace[trace.length - 1]!.nextState : "unknown";

  const succeeded =
    finalState === "done" || finalState === "terminated_pr_merged";

  return {
    totalSignals,
    fixCycles,
    maxFixCyclesBeforeBlock,
    totalDurationMs,
    convergenceRate,
    // Finding quality — signal replay doesn't produce findings
    totalFindings: 0,
    blockingFindings: 0,
    uniqueRootCauses: 0,
    signalToNoiseRatio: 0,
    crossReviewerDuplicates: 0,
    // Outcome
    finalState,
    succeeded,
  };
}
