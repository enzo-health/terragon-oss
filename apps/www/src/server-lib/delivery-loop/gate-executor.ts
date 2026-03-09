import type { ISandboxSession } from "@terragon/sandbox/types";
import type { DeliveryLoopState } from "@terragon/shared/model/delivery-loop";
import { runQualityCheckGateInSandbox } from "./quality-check-gate";
import { runDeepReviewGate } from "./deep-review-gate";
import { runCarmackReviewGate } from "./carmack-review-gate";

// ---------------------------------------------------------------------------
// Gate types
// ---------------------------------------------------------------------------

/**
 * Canonical gate types aligned to Delivery Loop states.
 * Each gate maps 1:1 to the canonical state it occupies.
 */
export type GateType =
  | "quality_check"
  | "deep_review"
  | "carmack_review"
  | "ci_evaluation"
  | "ui_smoke";

/**
 * Maps canonical Delivery Loop gate states to the gates that run in each.
 * review_gate runs deep_review + carmack_review.
 * ci_gate runs quality_check (lint/typecheck/test) + ci_evaluation.
 * ui_gate runs ui_smoke.
 */
export const gateStateToGateTypes: Record<
  "review_gate" | "ci_gate" | "ui_gate",
  readonly GateType[]
> = {
  review_gate: ["deep_review", "carmack_review"],
  ci_gate: ["quality_check"],
  ui_gate: ["ui_smoke"],
};

// ---------------------------------------------------------------------------
// Gate provenance — tracks determinism inputs
// ---------------------------------------------------------------------------

export type GateProvenance = {
  gateType: GateType;
  headSha: string;
  model: string | null;
  promptVersion: number | null;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
};

// ---------------------------------------------------------------------------
// Gate finding (shared across review gates)
// ---------------------------------------------------------------------------

export type GateFinding = {
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  detail: string;
  suggestedFix: string | null;
  isBlocking: boolean;
  stableFindingId?: string;
};

// ---------------------------------------------------------------------------
// Gate result — unified across all gate types
// ---------------------------------------------------------------------------

export type GateRunResult = {
  gateType: GateType;
  passed: boolean;
  findings: GateFinding[];
  summary: string | null;
  error: string | null;
  provenance: GateProvenance;
};

// ---------------------------------------------------------------------------
// Gate pipeline result
// ---------------------------------------------------------------------------

export type GatePipelineResult = {
  state: "review_gate" | "ci_gate" | "ui_gate";
  allPassed: boolean;
  gateResults: GateRunResult[];
  blockingFindings: GateFinding[];
};

// ---------------------------------------------------------------------------
// Bypass-once: SHA-scoped consumption
// ---------------------------------------------------------------------------

export type BypassOnceToken = {
  gate: GateType | "quality";
  headSha: string;
  actorUserId: string;
  loopVersion: number;
  artifactId: string;
};

/**
 * Checks whether a bypass-once token is valid for the current gate run.
 * A bypass token is only consumable if the HEAD SHA matches the SHA at
 * which the bypass was requested. This prevents a bypass requested on
 * commit A from being consumed on commit B.
 */
export function isBypassTokenValidForSha(
  token: BypassOnceToken,
  currentHeadSha: string,
): boolean {
  return token.headSha === currentHeadSha;
}

// ---------------------------------------------------------------------------
// Individual gate runners — thin wrappers producing GateRunResult
// ---------------------------------------------------------------------------

async function runQualityCheckGate(
  session: ISandboxSession,
  headSha: string,
): Promise<GateRunResult> {
  const startedAt = new Date();
  try {
    const result = await runQualityCheckGateInSandbox(session);
    const completedAt = new Date();
    return {
      gateType: "quality_check",
      passed: result.gatePassed,
      findings: result.failures.map((failure) => ({
        title: failure,
        severity: "high" as const,
        category: "quality",
        detail: failure,
        suggestedFix: null,
        isBlocking: true,
      })),
      summary: result.gatePassed
        ? "Quality checks passed."
        : `Quality checks failed: ${result.failures.length} failure(s).`,
      error: null,
      provenance: {
        gateType: "quality_check",
        headSha,
        model: null,
        promptVersion: null,
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      },
    };
  } catch (error) {
    const completedAt = new Date();
    return {
      gateType: "quality_check",
      passed: false,
      findings: [],
      summary: null,
      error: error instanceof Error ? error.message : String(error),
      provenance: {
        gateType: "quality_check",
        headSha,
        model: null,
        promptVersion: null,
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      },
    };
  }
}

async function runDeepReviewGateWrapped({
  session,
  repoFullName,
  prNumber,
  headSha,
  taskContext,
  gitDiff,
  model,
}: {
  session: ISandboxSession;
  repoFullName: string;
  prNumber: number | null;
  headSha: string;
  taskContext: string;
  gitDiff: string;
  model: string;
}): Promise<GateRunResult> {
  const startedAt = new Date();
  try {
    const output = await runDeepReviewGate({
      session,
      repoFullName,
      prNumber,
      headSha,
      taskContext,
      gitDiff,
      model,
    });
    const completedAt = new Date();
    const findings: GateFinding[] = (output.blockingFindings ?? []).map(
      (f) => ({
        title: f.title,
        severity: f.severity,
        category: f.category,
        detail: f.detail,
        suggestedFix: f.suggestedFix ?? null,
        isBlocking: f.isBlocking !== false,
        stableFindingId: f.stableFindingId,
      }),
    );
    return {
      gateType: "deep_review",
      passed: output.gatePassed,
      findings,
      summary: output.gatePassed
        ? "Deep review passed."
        : `Deep review blocked: ${findings.filter((f) => f.isBlocking).length} blocking finding(s).`,
      error: null,
      provenance: {
        gateType: "deep_review",
        headSha,
        model,
        promptVersion: 1,
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      },
    };
  } catch (error) {
    const completedAt = new Date();
    return {
      gateType: "deep_review",
      passed: false,
      findings: [],
      summary: null,
      error: error instanceof Error ? error.message : String(error),
      provenance: {
        gateType: "deep_review",
        headSha,
        model,
        promptVersion: 1,
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      },
    };
  }
}

async function runCarmackReviewGateWrapped({
  session,
  repoFullName,
  prNumber,
  headSha,
  taskContext,
  gitDiff,
  model,
}: {
  session: ISandboxSession;
  repoFullName: string;
  prNumber: number | null;
  headSha: string;
  taskContext: string;
  gitDiff: string;
  model: string;
}): Promise<GateRunResult> {
  const startedAt = new Date();
  try {
    const output = await runCarmackReviewGate({
      session,
      repoFullName,
      prNumber,
      headSha,
      taskContext,
      gitDiff,
      model,
    });
    const completedAt = new Date();
    const findings: GateFinding[] = (output.blockingFindings ?? []).map(
      (f) => ({
        title: f.title,
        severity: f.severity,
        category: f.category,
        detail: f.detail,
        suggestedFix: f.suggestedFix ?? null,
        isBlocking: f.isBlocking !== false,
        stableFindingId: f.stableFindingId,
      }),
    );
    return {
      gateType: "carmack_review",
      passed: output.gatePassed,
      findings,
      summary: output.gatePassed
        ? "Carmack review passed."
        : `Carmack review blocked: ${findings.filter((f) => f.isBlocking).length} blocking finding(s).`,
      error: null,
      provenance: {
        gateType: "carmack_review",
        headSha,
        model,
        promptVersion: 1,
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      },
    };
  } catch (error) {
    const completedAt = new Date();
    return {
      gateType: "carmack_review",
      passed: false,
      findings: [],
      summary: null,
      error: error instanceof Error ? error.message : String(error),
      provenance: {
        gateType: "carmack_review",
        headSha,
        model,
        promptVersion: 1,
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Gate pipeline executor — agent-agnostic, daemon-independent
// ---------------------------------------------------------------------------

export type ReviewGateInput = {
  session: ISandboxSession;
  repoFullName: string;
  prNumber: number | null;
  headSha: string;
  taskContext: string;
  gitDiff: string;
  model: string;
};

export type CiGateInput = {
  session: ISandboxSession;
  headSha: string;
  bypassToken: BypassOnceToken | null;
};

export type UiGateInput = {
  session: ISandboxSession;
  repoFullName: string;
  branchName: string;
  headSha: string;
  changedFiles: string[];
  model: string;
};

/**
 * Executes the review gate pipeline (deep_review + carmack_review).
 * Both reviews run in parallel. The gate passes only if both pass.
 * This is a deterministic sandbox job — no daemon dependency.
 */
export async function executeReviewGate(
  input: ReviewGateInput,
): Promise<GatePipelineResult> {
  const [deepResult, carmackResult] = await Promise.all([
    runDeepReviewGateWrapped(input),
    runCarmackReviewGateWrapped(input),
  ]);

  const gateResults = [deepResult, carmackResult];
  const allPassed = gateResults.every((r) => r.passed);
  const blockingFindings = gateResults.flatMap((r) =>
    r.findings.filter((f) => f.isBlocking),
  );

  return {
    state: "review_gate",
    allPassed,
    gateResults,
    blockingFindings,
  };
}

/**
 * Executes the CI gate pipeline (quality_check: lint/typecheck/test).
 * Respects bypass-once tokens that are SHA-scoped.
 * This is a deterministic sandbox job — no daemon dependency.
 */
export async function executeCiGate(
  input: CiGateInput,
): Promise<GatePipelineResult> {
  const bypassValid =
    input.bypassToken !== null &&
    isBypassTokenValidForSha(input.bypassToken, input.headSha);

  if (bypassValid) {
    return {
      state: "ci_gate",
      allPassed: true,
      gateResults: [
        {
          gateType: "quality_check",
          passed: true,
          findings: [],
          summary: "Quality gate bypassed (SHA-scoped bypass-once consumed).",
          error: null,
          provenance: {
            gateType: "quality_check",
            headSha: input.headSha,
            model: null,
            promptVersion: null,
            startedAt: new Date(),
            completedAt: new Date(),
            durationMs: 0,
          },
        },
      ],
      blockingFindings: [],
    };
  }

  const qualityResult = await runQualityCheckGate(input.session, input.headSha);

  return {
    state: "ci_gate",
    allPassed: qualityResult.passed,
    gateResults: [qualityResult],
    blockingFindings: qualityResult.findings.filter((f) => f.isBlocking),
  };
}

/**
 * Executes the UI gate pipeline (ui_smoke).
 * Checks whether any changed files include frontend patterns (components,
 * pages, styles, templates). If no frontend files were changed the gate
 * auto-passes. Otherwise it delegates to the sandbox session for a
 * lightweight smoke check.
 * This is a deterministic sandbox job — no daemon dependency.
 */
export async function executeUiGate(
  input: UiGateInput,
): Promise<GatePipelineResult> {
  const frontendPatterns =
    /\.(tsx|jsx|vue|svelte|html|css|scss|less|styl)$|\/pages\/|\/app\/|\/components\//;
  const hasFrontendChanges = input.changedFiles.some((f) =>
    frontendPatterns.test(f),
  );

  if (!hasFrontendChanges) {
    const now = new Date();
    return {
      state: "ui_gate",
      allPassed: true,
      gateResults: [
        {
          gateType: "ui_smoke",
          passed: true,
          findings: [],
          summary: "UI smoke gate skipped — no frontend files changed.",
          error: null,
          provenance: {
            gateType: "ui_smoke",
            headSha: input.headSha,
            model: null,
            promptVersion: null,
            startedAt: now,
            completedAt: now,
            durationMs: 0,
          },
        },
      ],
      blockingFindings: [],
    };
  }

  const startedAt = new Date();
  try {
    await input.session.runCommand("pnpm run build", {
      cwd: input.session.repoDir,
      timeoutMs: 300_000,
    });
    const completedAt = new Date();
    return {
      state: "ui_gate",
      allPassed: true,
      gateResults: [
        {
          gateType: "ui_smoke",
          passed: true,
          findings: [],
          summary: "UI smoke gate passed — build succeeded.",
          error: null,
          provenance: {
            gateType: "ui_smoke",
            headSha: input.headSha,
            model: null,
            promptVersion: null,
            startedAt,
            completedAt,
            durationMs: completedAt.getTime() - startedAt.getTime(),
          },
        },
      ],
      blockingFindings: [],
    };
  } catch (error) {
    const completedAt = new Date();
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      state: "ui_gate",
      allPassed: false,
      gateResults: [
        {
          gateType: "ui_smoke",
          passed: false,
          findings: [
            {
              title: "UI smoke build failed",
              severity: "high",
              category: "ui_smoke",
              detail: errorMsg,
              suggestedFix: null,
              isBlocking: true,
            },
          ],
          summary: `UI smoke gate failed: build error.`,
          error: errorMsg,
          provenance: {
            gateType: "ui_smoke",
            headSha: input.headSha,
            model: null,
            promptVersion: null,
            startedAt,
            completedAt,
            durationMs: completedAt.getTime() - startedAt.getTime(),
          },
        },
      ],
      blockingFindings: [
        {
          title: "UI smoke build failed",
          severity: "high",
          category: "ui_smoke",
          detail: errorMsg,
          suggestedFix: null,
          isBlocking: true,
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Full gate pipeline orchestrator
// ---------------------------------------------------------------------------

export type GatePipelineInput = {
  reviewInput: ReviewGateInput;
  ciInput: CiGateInput;
  uiInput: UiGateInput;
  hasPr: boolean;
};

export type FullGatePipelineResult = {
  allPassed: boolean;
  results: GatePipelineResult[];
  nextState: DeliveryLoopState;
  stoppedAtGate: "review_gate" | "ci_gate" | "ui_gate" | null;
};

/**
 * Sequences the full gate pipeline: review_gate -> ci_gate -> ui_gate.
 * Short-circuits on first gate failure — subsequent gates are not executed.
 * Both agents (Claude Code, Codex) enter this identical pipeline.
 */
export async function executeGatePipeline(
  input: GatePipelineInput,
): Promise<FullGatePipelineResult> {
  const results: GatePipelineResult[] = [];

  const reviewResult = await executeReviewGate(input.reviewInput);
  results.push(reviewResult);
  if (!reviewResult.allPassed) {
    return {
      allPassed: false,
      results,
      nextState: "implementing",
      stoppedAtGate: "review_gate",
    };
  }

  const ciResult = await executeCiGate(input.ciInput);
  results.push(ciResult);
  if (!ciResult.allPassed) {
    return {
      allPassed: false,
      results,
      nextState: "implementing",
      stoppedAtGate: "ci_gate",
    };
  }

  const uiResult = await executeUiGate(input.uiInput);
  results.push(uiResult);
  if (!uiResult.allPassed) {
    return {
      allPassed: false,
      results,
      nextState: "implementing",
      stoppedAtGate: "ui_gate",
    };
  }

  return {
    allPassed: true,
    results,
    nextState: input.hasPr ? "babysitting" : "awaiting_pr_link",
    stoppedAtGate: null,
  };
}

/**
 * Resolves the next canonical state after a gate pipeline completes.
 * Maps gate pass/fail to the appropriate DeliveryLoopTransitionEvent.
 */
export function resolveGateTransitionEvent(
  result: GatePipelineResult,
  hasPr: boolean,
):
  | "review_gate_passed"
  | "review_gate_blocked"
  | "ci_gate_passed"
  | "ci_gate_blocked"
  | "ui_gate_passed_with_pr"
  | "ui_gate_passed_without_pr"
  | "ui_gate_blocked" {
  switch (result.state) {
    case "review_gate":
      return result.allPassed ? "review_gate_passed" : "review_gate_blocked";
    case "ci_gate":
      return result.allPassed ? "ci_gate_passed" : "ci_gate_blocked";
    case "ui_gate":
      if (!result.allPassed) return "ui_gate_blocked";
      return hasPr ? "ui_gate_passed_with_pr" : "ui_gate_passed_without_pr";
  }
}

/**
 * Returns the canonical DeliveryLoopState after a gate pipeline completes,
 * per the state machine transition table.
 */
export function resolvePostGateState(
  result: GatePipelineResult,
  hasPr: boolean,
): DeliveryLoopState {
  switch (result.state) {
    case "review_gate":
      return result.allPassed ? "ci_gate" : "implementing";
    case "ci_gate":
      return result.allPassed ? "ui_gate" : "implementing";
    case "ui_gate":
      if (!result.allPassed) return "implementing";
      return hasPr ? "babysitting" : "awaiting_pr_link";
  }
}
