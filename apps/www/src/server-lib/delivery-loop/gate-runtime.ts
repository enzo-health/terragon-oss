import type { ISandboxSession } from "@terragon/sandbox/types";
import type { DeliveryLoopState } from "@terragon/shared/model/delivery-loop";
import {
  executeReviewGate,
  executeCiGate,
  executeUiGate,
  isBypassTokenValidForSha,
  type BypassOnceToken,
  type GatePipelineResult,
} from "./gate-executor";

// ---------------------------------------------------------------------------
// GateResult — the simplified provenance type requested by the RFC
// ---------------------------------------------------------------------------

export type GateResult = {
  gate: "review_gate" | "ci_gate" | "ui_gate";
  headSha: string;
  passed: boolean;
  failureReason: string | null;
  startedAt: Date;
  completedAt: Date;
};

// ---------------------------------------------------------------------------
// GatePipelineOutcome — the full pipeline result with provenance
// ---------------------------------------------------------------------------

export type GatePipelineOutcome = {
  allPassed: boolean;
  gateResults: GateResult[];
  nextState: DeliveryLoopState;
  stoppedAtGate: "review_gate" | "ci_gate" | "ui_gate" | null;
  /** Raw gate results for detailed inspection (findings, provenance). */
  rawResults: GatePipelineResult[];
};

// ---------------------------------------------------------------------------
// Pipeline input
// ---------------------------------------------------------------------------

export type GateRuntimeInput = {
  session: ISandboxSession;
  repoFullName: string;
  prNumber: number | null;
  branchName: string;
  headSha: string;
  taskContext: string;
  gitDiff: string;
  changedFiles: string[];
  model: string;
  hasPr: boolean;
  bypassToken: BypassOnceToken | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toGateResult(
  gate: GateResult["gate"],
  pipelineResult: GatePipelineResult,
  headSha: string,
): GateResult {
  const now = new Date();
  const firstStart =
    pipelineResult.gateResults.length > 0
      ? pipelineResult.gateResults.reduce(
          (min, r) =>
            r.provenance.startedAt < min ? r.provenance.startedAt : min,
          pipelineResult.gateResults[0]!.provenance.startedAt,
        )
      : now;
  const lastComplete =
    pipelineResult.gateResults.length > 0
      ? pipelineResult.gateResults.reduce(
          (max, r) =>
            r.provenance.completedAt > max ? r.provenance.completedAt : max,
          pipelineResult.gateResults[0]!.provenance.completedAt,
        )
      : now;

  let failureReason: string | null = null;
  if (!pipelineResult.allPassed) {
    const failedGates = pipelineResult.gateResults.filter((r) => !r.passed);
    failureReason =
      failedGates
        .map((r) => r.error ?? r.summary ?? `${r.gateType} failed`)
        .join("; ") || "gate failed";
  }

  return {
    gate,
    headSha,
    passed: pipelineResult.allPassed,
    failureReason,
    startedAt: firstStart,
    completedAt: lastComplete,
  };
}

// ---------------------------------------------------------------------------
// Bypass consumption
// ---------------------------------------------------------------------------

/**
 * Evaluates whether a bypass token should be consumed for the current gate run.
 * Returns true if the token is valid (SHA matches) and should be consumed.
 * The caller is responsible for marking the bypass as consumed in the DB.
 */
export function shouldConsumeBypass(
  token: BypassOnceToken | null,
  currentHeadSha: string,
): boolean {
  if (token === null) return false;
  return isBypassTokenValidForSha(token, currentHeadSha);
}

// ---------------------------------------------------------------------------
// Gate pipeline runtime — the single entry point for the delivery loop
// ---------------------------------------------------------------------------

/**
 * Runs the full deterministic gate pipeline: review_gate → ci_gate → ui_gate.
 *
 * This is the single entry point the Delivery Loop state machine calls after
 * implementation success. Both agents (Claude Code, Codex) enter this
 * identical pipeline. Gates run via `session.runCommand()` — no daemon
 * dependency.
 *
 * Short-circuits on first gate failure. On failure, `nextState` is
 * `"implementing"` (the retry policy uses `gate_failed` →
 * `return_to_implementing`).
 */
export async function runGatePipeline(
  input: GateRuntimeInput,
): Promise<GatePipelineOutcome> {
  const gateResults: GateResult[] = [];
  const rawResults: GatePipelineResult[] = [];

  // --- review_gate ---
  const reviewResult = await executeReviewGate({
    session: input.session,
    repoFullName: input.repoFullName,
    prNumber: input.prNumber,
    headSha: input.headSha,
    taskContext: input.taskContext,
    gitDiff: input.gitDiff,
    model: input.model,
  });
  rawResults.push(reviewResult);
  gateResults.push(toGateResult("review_gate", reviewResult, input.headSha));
  if (!reviewResult.allPassed) {
    return {
      allPassed: false,
      gateResults,
      nextState: "implementing",
      stoppedAtGate: "review_gate",
      rawResults,
    };
  }

  // --- ci_gate ---
  const ciResult = await executeCiGate({
    session: input.session,
    headSha: input.headSha,
    bypassToken: input.bypassToken,
  });
  rawResults.push(ciResult);
  gateResults.push(toGateResult("ci_gate", ciResult, input.headSha));
  if (!ciResult.allPassed) {
    return {
      allPassed: false,
      gateResults,
      nextState: "implementing",
      stoppedAtGate: "ci_gate",
      rawResults,
    };
  }

  // --- ui_gate ---
  const uiResult = await executeUiGate({
    session: input.session,
    repoFullName: input.repoFullName,
    branchName: input.branchName,
    headSha: input.headSha,
    changedFiles: input.changedFiles,
    model: input.model,
  });
  rawResults.push(uiResult);
  gateResults.push(toGateResult("ui_gate", uiResult, input.headSha));
  if (!uiResult.allPassed) {
    return {
      allPassed: false,
      gateResults,
      nextState: "implementing",
      stoppedAtGate: "ui_gate",
      rawResults,
    };
  }

  return {
    allPassed: true,
    gateResults,
    nextState: input.hasPr ? "babysitting" : "awaiting_pr_link",
    stoppedAtGate: null,
    rawResults,
  };
}
