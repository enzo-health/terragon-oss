/**
 * Unit tests for reduceSignalToEvent — pure function, no DB needed.
 *
 * Covers every branch in the signal→event reduction logic across all five
 * signal sources: daemon, github, human, timer, babysit.
 */
import { describe, expect, it } from "vitest";
import {
  reduceSignalToEvent,
  type SignalReductionResult,
} from "./reduce-signals";
import type {
  DeliveryWorkflow,
  WorkflowId,
  ThreadId,
  PlanVersion,
  DispatchId,
  GitSha,
  GateKind,
  DispatchSubState,
  GateSubState,
  ReviewSurfaceRef,
} from "@terragon/shared/delivery-loop/domain/workflow";
import type {
  DeliverySignal,
  DaemonSignal,
  GitHubSignal,
  HumanSignal,
  TimerSignal,
  BabysitSignal,
} from "@terragon/shared/delivery-loop/domain/signals";
import type { GateVerdict } from "@terragon/shared/delivery-loop/domain/events";
import {
  extractFailureSignature,
  type FailureSignatureMap,
} from "@terragon/shared/delivery-loop/domain/failure-signature";

// ---------------------------------------------------------------------------
// Helpers — workflow snapshot builders
// ---------------------------------------------------------------------------

const COMMON = {
  workflowId: "wf-1" as WorkflowId,
  threadId: "th-1" as ThreadId,
  generation: 1,
  version: 1,
  fixAttemptCount: 0,
  infraRetryCount: 0,
  maxFixAttempts: 5,
  createdAt: new Date(),
  updatedAt: new Date(),
  lastActivityAt: null,
} as const;

function planning(planVersion: PlanVersion | null = null): DeliveryWorkflow {
  return { ...COMMON, kind: "planning", planVersion };
}

function implementing(
  overrides: Partial<{
    fixAttemptCount: number;
    infraRetryCount: number;
    maxFixAttempts: number;
    dispatch: DispatchSubState;
    planVersion: PlanVersion;
  }> = {},
): DeliveryWorkflow {
  return {
    ...COMMON,
    kind: "implementing",
    planVersion: overrides.planVersion ?? (1 as PlanVersion),
    dispatch: overrides.dispatch ?? {
      kind: "acknowledged",
      dispatchId: "d-1" as DispatchId,
      executionClass: "implementation_runtime",
      sentAt: new Date(),
      acknowledgedAt: new Date(),
    },
    fixAttemptCount: overrides.fixAttemptCount ?? 0,
    infraRetryCount: overrides.infraRetryCount ?? 0,
    maxFixAttempts: overrides.maxFixAttempts ?? 5,
  };
}

function gating(
  gateKind: GateKind,
  headSha: string = "abc123",
): DeliveryWorkflow {
  const gate: GateSubState =
    gateKind === "ci"
      ? {
          kind: "ci",
          status: "waiting",
          runId: null,
          snapshot: { checkSuites: [], failingRequiredChecks: [] },
        }
      : gateKind === "review"
        ? {
            kind: "review",
            status: "waiting",
            runId: null,
            snapshot: {
              requiredApprovals: 1,
              approvalsReceived: 0,
              blockers: [],
            },
          }
        : {
            kind: "ui",
            status: "waiting",
            runId: null,
            snapshot: { artifactUrl: null, blockers: [] },
          };
  return {
    ...COMMON,
    kind: "gating",
    headSha: headSha as GitSha,
    gate,
  };
}

function babysitting(headSha = "abc123"): DeliveryWorkflow {
  return {
    ...COMMON,
    kind: "babysitting",
    headSha: headSha as GitSha,
    reviewSurface: { kind: "github_pr", prNumber: 42 } as ReviewSurfaceRef,
    nextCheckAt: new Date(),
  };
}

function awaitingPr(headSha = "abc123"): DeliveryWorkflow {
  return { ...COMMON, kind: "awaiting_pr", headSha: headSha as GitSha };
}

function done(): DeliveryWorkflow {
  return {
    ...COMMON,
    kind: "done",
    outcome: "completed",
    completedAt: new Date(),
  };
}

function awaitingPlanApproval(): DeliveryWorkflow {
  return {
    ...COMMON,
    kind: "awaiting_plan_approval",
    planVersion: 1 as PlanVersion,
    resumableFrom: { kind: "planning", planVersion: 1 as PlanVersion },
  };
}

function awaitingManualFix(): DeliveryWorkflow {
  return {
    ...COMMON,
    kind: "awaiting_manual_fix",
    reason: { description: "test", suggestedAction: null },
    resumableFrom: {
      kind: "implementing",
      dispatchId: "d-1" as DispatchId,
      planVersion: 1 as PlanVersion,
    },
  };
}

// Helpers for signal construction
function daemonSignal(event: DaemonSignal): DeliverySignal {
  return { source: "daemon", event };
}

function githubSignal(event: GitHubSignal): DeliverySignal {
  return { source: "github", event };
}

function humanSignal(event: HumanSignal): DeliverySignal {
  return { source: "human", event };
}

function timerSignal(event: TimerSignal): DeliverySignal {
  return { source: "timer", event };
}

function babysitSignal(event: BabysitSignal): DeliverySignal {
  return { source: "babysit", event };
}

function reduce(
  signal: DeliverySignal,
  workflow: DeliveryWorkflow,
  gateVerdicts?: GateVerdict[],
): SignalReductionResult {
  return reduceSignalToEvent({ signal, workflow, gateVerdicts });
}

function expectEvent(
  result: SignalReductionResult,
  event: string,
  context?: Record<string, unknown>,
) {
  expect(result).not.toBeNull();
  expect(result).not.toHaveProperty("retryable");
  const r = result as { event: string; context: Record<string, unknown> };
  expect(r.event).toBe(event);
  if (context) {
    expect(r.context).toMatchObject(context);
  }
}

function expectRetryable(result: SignalReductionResult) {
  expect(result).not.toBeNull();
  expect(result).toHaveProperty("retryable", true);
  expect(result).toHaveProperty("reason");
}

// ---------------------------------------------------------------------------
// Daemon signals
// ---------------------------------------------------------------------------

describe("reduceSignalToEvent", () => {
  describe("daemon signals", () => {
    describe("run_completed", () => {
      it("planning state → plan_completed", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_completed",
            runId: "r1",
            result: { kind: "success", headSha: "sha1", summary: "done" },
          }),
          planning(),
        );
        expectEvent(result, "plan_completed");
      });

      it("implementing + partial → redispatch_requested", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_completed",
            runId: "r1",
            result: {
              kind: "partial",
              headSha: "sha1",
              summary: "partial",
              remainingTasks: 3,
            },
          }),
          implementing(),
        );
        expectEvent(result, "redispatch_requested");
      });

      it("implementing + success → implementation_completed", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_completed",
            runId: "r1",
            result: { kind: "success", headSha: "sha1", summary: "done" },
          }),
          implementing(),
        );
        expectEvent(result, "implementation_completed", { headSha: "sha1" });
      });

      it("implementing + queued dispatch (missing start/ack) still completes", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_completed",
            runId: "r1",
            result: { kind: "success", headSha: "sha1", summary: "done" },
          }),
          implementing({
            dispatch: {
              kind: "queued",
              dispatchId: "d-queued" as DispatchId,
              executionClass: "implementation_runtime",
            },
          }),
        );
        expectEvent(result, "implementation_completed", { headSha: "sha1" });
      });

      it("implementing + failed dispatch ignores terminal run_completed", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_completed",
            runId: "r1",
            result: { kind: "success", headSha: "sha1", summary: "done" },
          }),
          implementing({
            dispatch: {
              kind: "failed",
              dispatchId: "d-fail" as DispatchId,
              executionClass: "implementation_runtime",
              failure: { kind: "ack_timeout" },
              failedAt: new Date(),
            },
          }),
        );
        expect(result).toBeNull();
      });

      it("gating state → null", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_completed",
            runId: "r1",
            result: { kind: "success", headSha: "sha1", summary: "done" },
          }),
          gating("ci"),
        );
        expect(result).toBeNull();
      });

      it("babysitting state → null", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_completed",
            runId: "r1",
            result: { kind: "success", headSha: "sha1", summary: "done" },
          }),
          babysitting(),
        );
        expect(result).toBeNull();
      });

      it("done state → null", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_completed",
            runId: "r1",
            result: { kind: "success", headSha: "sha1", summary: "done" },
          }),
          done(),
        );
        expect(result).toBeNull();
      });
    });

    describe("run_failed", () => {
      it("implementing + under budget + runtime_crash → gate_blocked", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_failed",
            runId: "r1",
            failure: { kind: "runtime_crash", exitCode: 1, message: "crash" },
          }),
          implementing({ fixAttemptCount: 0, maxFixAttempts: 5 }),
        );
        expectEvent(result, "gate_blocked");
      });

      it("implementing + queued dispatch (missing start/ack) still marks blocked", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_failed",
            runId: "r1",
            failure: { kind: "runtime_crash", exitCode: 1, message: "crash" },
          }),
          implementing({
            dispatch: {
              kind: "queued",
              dispatchId: "d-queued" as DispatchId,
              executionClass: "implementation_runtime",
            },
          }),
        );
        expectEvent(result, "gate_blocked");
      });

      it("implementing + failed dispatch ignores terminal run_failed", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_failed",
            runId: "r1",
            failure: { kind: "runtime_crash", exitCode: 1, message: "crash" },
          }),
          implementing({
            dispatch: {
              kind: "failed",
              dispatchId: "d-fail" as DispatchId,
              executionClass: "implementation_runtime",
              failure: { kind: "transport_error", message: "timeout" },
              failedAt: new Date(),
            },
          }),
        );
        expect(result).toBeNull();
      });

      it("implementing + under budget + timeout → gate_blocked", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_failed",
            runId: "r1",
            failure: { kind: "timeout", durationMs: 60000 },
          }),
          implementing({ fixAttemptCount: 0, maxFixAttempts: 5 }),
        );
        expectEvent(result, "gate_blocked");
      });

      it("implementing + under budget + oom → gate_blocked", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_failed",
            runId: "r1",
            failure: { kind: "oom", durationMs: 60000 },
          }),
          implementing({ fixAttemptCount: 1, maxFixAttempts: 5 }),
        );
        expectEvent(result, "gate_blocked");
      });

      it("implementing + at max fix attempts → exhausted_retries", () => {
        // maxFixAttempts=5, fixAttemptCount=4 → 4 >= 5-1 → exhausted
        const result = reduce(
          daemonSignal({
            kind: "run_failed",
            runId: "r1",
            failure: { kind: "runtime_crash", exitCode: 1, message: "crash" },
          }),
          implementing({ fixAttemptCount: 4, maxFixAttempts: 5 }),
        );
        expectEvent(result, "exhausted_retries");
      });

      it("implementing + config_error → exhausted_retries (immediate)", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_failed",
            runId: "r1",
            failure: { kind: "config_error", message: "bad config" },
          }),
          implementing({ fixAttemptCount: 0, maxFixAttempts: 5 }),
        );
        expectEvent(result, "exhausted_retries");
      });

      it("gating → gate_blocked", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_failed",
            runId: "r1",
            failure: { kind: "runtime_crash", exitCode: 1, message: "crash" },
          }),
          gating("ci"),
        );
        expectEvent(result, "gate_blocked");
      });

      it("planning → gate_blocked (re-dispatch planning run)", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_failed",
            runId: "r1",
            failure: { kind: "runtime_crash", exitCode: 1, message: "crash" },
          }),
          planning(),
        );
        expectEvent(result, "gate_blocked");
      });

      it("done state → null", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_failed",
            runId: "r1",
            failure: { kind: "runtime_crash", exitCode: 1, message: "crash" },
          }),
          done(),
        );
        expect(result).toBeNull();
      });

      // Infrastructure failure tests (ACP transient "Internal error")
      it("implementing + infra failure → redispatch_requested (no fixAttemptCount penalty)", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_failed",
            runId: "r1",
            failure: {
              kind: "runtime_crash",
              exitCode: null,
              message: "Internal error",
            },
          }),
          implementing({ fixAttemptCount: 3, maxFixAttempts: 5 }),
        );
        expectEvent(result, "redispatch_requested");
      });

      it("implementing + infra failure at max fixAttempts still retries (budget not consumed)", () => {
        // fixAttemptCount=4 would normally trigger exhausted_retries, but infra
        // failures bypass the fix budget entirely.
        const result = reduce(
          daemonSignal({
            kind: "run_failed",
            runId: "r1",
            failure: {
              kind: "runtime_crash",
              exitCode: null,
              message: "Internal error",
            },
          }),
          implementing({ fixAttemptCount: 4, maxFixAttempts: 5 }),
        );
        expectEvent(result, "redispatch_requested");
      });

      it("implementing + infra failure with exhausted infra retries → exhausted_retries", () => {
        // Pre-populate 9 infra failures so the 10th trips the circuit breaker
        const failure = {
          kind: "runtime_crash" as const,
          exitCode: null,
          message: "Internal error",
        };
        const now = new Date();
        let map: FailureSignatureMap = {};
        for (let i = 0; i < 9; i++) {
          ({ updatedMap: map } = extractFailureSignature(
            failure,
            "daemon",
            map,
            now,
          ));
        }
        const wf = implementing({
          fixAttemptCount: 0,
          maxFixAttempts: 5,
        });
        const wfWithSigs = { ...wf, failureSignatures: map };
        const result = reduce(
          daemonSignal({
            kind: "run_failed",
            runId: "r1",
            failure,
          }),
          wfWithSigs as DeliveryWorkflow,
        );
        expectEvent(result, "exhausted_retries");
      });

      it("implementing + non-infra runtime_crash still consumes fix budget", () => {
        // "crash" is a real agent failure, not "Internal error"
        const result = reduce(
          daemonSignal({
            kind: "run_failed",
            runId: "r1",
            failure: { kind: "runtime_crash", exitCode: 1, message: "crash" },
          }),
          implementing({ fixAttemptCount: 4, maxFixAttempts: 5 }),
        );
        expectEvent(result, "exhausted_retries");
      });
    });

    describe("progress_reported", () => {
      it("any state → null", () => {
        const signal = daemonSignal({
          kind: "progress_reported",
          runId: "r1",
          progress: { completedTasks: 1, totalTasks: 3, currentTask: "task1" },
        });
        expect(reduce(signal, planning())).toBeNull();
        expect(reduce(signal, implementing())).toBeNull();
        expect(reduce(signal, gating("ci"))).toBeNull();
        expect(reduce(signal, babysitting())).toBeNull();
      });
    });

    describe("gate_completed", () => {
      it("gating + passed → gate_passed", () => {
        const result = reduce(
          daemonSignal({
            kind: "gate_completed",
            runId: "r1",
            gate: "ui",
            passed: true,
            headSha: "sha1",
          }),
          gating("ui"),
        );
        expectEvent(result, "gate_passed", { gate: "ui", headSha: "sha1" });
      });

      it("gating + failed → gate_blocked", () => {
        const result = reduce(
          daemonSignal({
            kind: "gate_completed",
            runId: "r1",
            gate: "ui",
            passed: false,
            headSha: "sha1",
          }),
          gating("ui"),
        );
        expectEvent(result, "gate_blocked", { gate: "ui", headSha: "sha1" });
      });

      it("implementing → null", () => {
        const result = reduce(
          daemonSignal({
            kind: "gate_completed",
            runId: "r1",
            gate: "ui",
            passed: true,
            headSha: "sha1",
          }),
          implementing(),
        );
        expect(result).toBeNull();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GitHub signals
  // ---------------------------------------------------------------------------

  describe("github signals", () => {
    describe("ci_changed", () => {
      it("gating(ci) + stale headSha → null", () => {
        const result = reduce(
          githubSignal({
            kind: "ci_changed",
            prNumber: 1,
            headSha: "stale-sha",
            result: {
              passed: true,
              requiredChecks: ["build"],
              failingChecks: [],
            },
          }),
          gating("ci", "current-sha"),
        );
        expect(result).toBeNull();
      });

      it("gating(ci) + matching headSha + verdict provided → gate_passed", () => {
        const verdicts: GateVerdict[] = [
          {
            gate: "ci",
            passed: true,
            event: "gate_passed",
            runId: "r1",
            headSha: "abc123" as GitSha,
            loopVersion: 1,
          },
        ];
        const result = reduce(
          githubSignal({
            kind: "ci_changed",
            prNumber: 1,
            headSha: "abc123",
            result: {
              passed: true,
              requiredChecks: ["build"],
              failingChecks: [],
            },
          }),
          gating("ci"),
          verdicts,
        );
        expectEvent(result, "gate_passed", { gate: "ci" });
      });

      it("gating(ci) + matching headSha + verdict failed → gate_blocked", () => {
        const verdicts: GateVerdict[] = [
          {
            gate: "ci",
            passed: false,
            event: "gate_blocked",
            runId: "r1",
            headSha: "abc123" as GitSha,
            loopVersion: 1,
          },
        ];
        const result = reduce(
          githubSignal({
            kind: "ci_changed",
            prNumber: 1,
            headSha: "abc123",
            result: {
              passed: false,
              requiredChecks: ["build"],
              failingChecks: ["build"],
            },
          }),
          gating("ci"),
          verdicts,
        );
        expectEvent(result, "gate_blocked", { gate: "ci" });
      });

      it("gating(ci) + no required checks → retryable", () => {
        const result = reduce(
          githubSignal({
            kind: "ci_changed",
            prNumber: 1,
            result: { passed: false, requiredChecks: [], failingChecks: [] },
          }),
          gating("ci"),
        );
        expectRetryable(result);
      });

      it("gating(ci) + 0 failing checks → gate_passed", () => {
        const result = reduce(
          githubSignal({
            kind: "ci_changed",
            prNumber: 1,
            result: {
              passed: true,
              requiredChecks: ["build"],
              failingChecks: [],
            },
          }),
          gating("ci"),
        );
        expectEvent(result, "gate_passed", { gate: "ci" });
      });

      it("gating(ci) + some failing → gate_blocked", () => {
        const result = reduce(
          githubSignal({
            kind: "ci_changed",
            prNumber: 1,
            result: {
              passed: false,
              requiredChecks: ["build", "lint"],
              failingChecks: ["lint"],
            },
          }),
          gating("ci"),
        );
        expectEvent(result, "gate_blocked", { gate: "ci" });
      });

      it("gating(review) — ci signal on wrong gate substate → retryable (active non-terminal)", () => {
        // gating is active non-terminal but gate.kind is review, not ci
        // The code checks workflow.kind === "gating" && workflow.gate.kind === "ci"
        // which is false, so falls through to isActiveNonTerminal check
        const result = reduce(
          githubSignal({
            kind: "ci_changed",
            prNumber: 1,
            result: {
              passed: true,
              requiredChecks: ["build"],
              failingChecks: [],
            },
          }),
          gating("review"),
        );
        expectRetryable(result);
      });

      it("babysitting → retryable", () => {
        const result = reduce(
          githubSignal({
            kind: "ci_changed",
            prNumber: 1,
            result: {
              passed: true,
              requiredChecks: ["build"],
              failingChecks: [],
            },
          }),
          babysitting(),
        );
        expectRetryable(result);
      });

      it("implementing → retryable", () => {
        const result = reduce(
          githubSignal({
            kind: "ci_changed",
            prNumber: 1,
            result: {
              passed: true,
              requiredChecks: ["build"],
              failingChecks: [],
            },
          }),
          implementing(),
        );
        expectRetryable(result);
      });

      it("done (terminal) → null", () => {
        const result = reduce(
          githubSignal({
            kind: "ci_changed",
            prNumber: 1,
            result: {
              passed: true,
              requiredChecks: ["build"],
              failingChecks: [],
            },
          }),
          done(),
        );
        expect(result).toBeNull();
      });
    });

    describe("review_changed", () => {
      it("gating(review) + stale headSha → null", () => {
        const result = reduce(
          githubSignal({
            kind: "review_changed",
            prNumber: 1,
            headSha: "stale-sha",
            result: {
              passed: true,
              unresolvedThreadCount: 0,
              approvalCount: 1,
              requiredApprovals: 1,
            },
          }),
          gating("review", "current-sha"),
        );
        expect(result).toBeNull();
      });

      it("gating(review) + passed → gate_passed", () => {
        const result = reduce(
          githubSignal({
            kind: "review_changed",
            prNumber: 1,
            result: {
              passed: true,
              unresolvedThreadCount: 0,
              approvalCount: 1,
              requiredApprovals: 1,
            },
          }),
          gating("review"),
        );
        expectEvent(result, "gate_passed", { gate: "review" });
      });

      it("gating(review) + failed → gate_blocked", () => {
        const result = reduce(
          githubSignal({
            kind: "review_changed",
            prNumber: 1,
            result: {
              passed: false,
              unresolvedThreadCount: 2,
              approvalCount: 0,
              requiredApprovals: 1,
            },
          }),
          gating("review"),
        );
        expectEvent(result, "gate_blocked", { gate: "review" });
      });

      it("gating(review) + verdict override → uses verdict", () => {
        const verdicts: GateVerdict[] = [
          {
            gate: "review",
            passed: true,
            event: "gate_passed",
            runId: "r1",
            headSha: "abc123" as GitSha,
            loopVersion: 1,
          },
        ];
        // Signal says failed but verdict says passed
        const result = reduce(
          githubSignal({
            kind: "review_changed",
            prNumber: 1,
            result: {
              passed: false,
              unresolvedThreadCount: 2,
              approvalCount: 0,
              requiredApprovals: 1,
            },
          }),
          gating("review"),
          verdicts,
        );
        expectEvent(result, "gate_passed", { gate: "review" });
      });

      it("babysitting → retryable", () => {
        const result = reduce(
          githubSignal({
            kind: "review_changed",
            prNumber: 1,
            result: {
              passed: true,
              unresolvedThreadCount: 0,
              approvalCount: 1,
              requiredApprovals: 1,
            },
          }),
          babysitting(),
        );
        expectRetryable(result);
      });

      it("implementing (active non-terminal) → retryable", () => {
        const result = reduce(
          githubSignal({
            kind: "review_changed",
            prNumber: 1,
            result: {
              passed: true,
              unresolvedThreadCount: 0,
              approvalCount: 1,
              requiredApprovals: 1,
            },
          }),
          implementing(),
        );
        expectRetryable(result);
      });

      it("gating(ci) — review signal on wrong gate substate → retryable", () => {
        const result = reduce(
          githubSignal({
            kind: "review_changed",
            prNumber: 1,
            result: {
              passed: true,
              unresolvedThreadCount: 0,
              approvalCount: 1,
              requiredApprovals: 1,
            },
          }),
          gating("ci"),
        );
        expectRetryable(result);
      });

      it("done (terminal) → null", () => {
        const result = reduce(
          githubSignal({
            kind: "review_changed",
            prNumber: 1,
            result: {
              passed: true,
              unresolvedThreadCount: 0,
              approvalCount: 1,
              requiredApprovals: 1,
            },
          }),
          done(),
        );
        expect(result).toBeNull();
      });
    });

    describe("pr_closed", () => {
      it("merged → pr_merged", () => {
        const result = reduce(
          githubSignal({ kind: "pr_closed", prNumber: 1, merged: true }),
          implementing(),
        );
        expectEvent(result, "pr_merged");
      });

      it("not merged → pr_closed", () => {
        const result = reduce(
          githubSignal({ kind: "pr_closed", prNumber: 1, merged: false }),
          implementing(),
        );
        expectEvent(result, "pr_closed");
      });
    });

    describe("pr_synchronized", () => {
      it("awaiting_pr → pr_linked", () => {
        const result = reduce(
          githubSignal({
            kind: "pr_synchronized",
            prNumber: 42,
            headSha: "sha1",
          }),
          awaitingPr(),
        );
        expectEvent(result, "pr_linked", { prNumber: 42 });
      });

      it("other state → null", () => {
        const result = reduce(
          githubSignal({
            kind: "pr_synchronized",
            prNumber: 42,
            headSha: "sha1",
          }),
          implementing(),
        );
        expect(result).toBeNull();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Human signals
  // ---------------------------------------------------------------------------

  describe("human signals", () => {
    it("resume_requested → blocked_resume", () => {
      const result = reduce(
        humanSignal({ kind: "resume_requested", actorUserId: "u1" }),
        awaitingManualFix(),
      );
      expectEvent(result, "blocked_resume");
    });

    it("bypass_requested → gate_passed with target", () => {
      const result = reduce(
        humanSignal({
          kind: "bypass_requested",
          actorUserId: "u1",
          target: "ci",
        }),
        gating("ci"),
      );
      expectEvent(result, "gate_passed", { gate: "ci" });
    });

    it("stop_requested → manual_stop", () => {
      const result = reduce(
        humanSignal({ kind: "stop_requested", actorUserId: "u1" }),
        implementing(),
      );
      expectEvent(result, "manual_stop");
    });

    it("mark_done_requested → mark_done", () => {
      const result = reduce(
        humanSignal({ kind: "mark_done_requested", actorUserId: "u1" }),
        babysitting(),
      );
      expectEvent(result, "mark_done");
    });

    it("operator_action_required → operator_action_required in awaiting_pr", () => {
      const result = reduce(
        humanSignal({
          kind: "operator_action_required",
          reason: { description: "Missing branch", system: "github" },
          incidentId: "inc-1",
        }),
        awaitingPr(),
      );
      expectEvent(result, "operator_action_required", {
        reason: "Missing branch",
        incidentId: "inc-1",
      });
    });

    it("plan_approved → plan_completed", () => {
      const result = reduce(
        humanSignal({ kind: "plan_approved", artifactId: "art-1" }),
        awaitingPlanApproval(),
      );
      expectEvent(result, "plan_completed");
    });
  });

  // ---------------------------------------------------------------------------
  // Timer signals
  // ---------------------------------------------------------------------------

  describe("timer signals", () => {
    describe("dispatch_ack_expired", () => {
      it("<= 5 consecutive failures → gate_blocked (infraRetry)", () => {
        const result = reduce(
          timerSignal({
            kind: "dispatch_ack_expired",
            dispatchId: "d-1" as DispatchId,
            consecutiveFailures: 3,
          }),
          implementing(),
        );
        expectEvent(result, "gate_blocked", { infraRetry: true });
      });

      it("default (no consecutiveFailures) → gate_blocked (infraRetry)", () => {
        const result = reduce(
          timerSignal({
            kind: "dispatch_ack_expired",
            dispatchId: "d-1" as DispatchId,
          }),
          implementing(),
        );
        expectEvent(result, "gate_blocked", { infraRetry: true });
      });

      it("> 5 consecutive failures in implementing → exhausted_retries", () => {
        const result = reduce(
          timerSignal({
            kind: "dispatch_ack_expired",
            dispatchId: "d-1" as DispatchId,
            consecutiveFailures: 6,
          }),
          implementing(),
        );
        expectEvent(result, "exhausted_retries");
      });

      it("exactly 5 consecutive failures in implementing → exhausted_retries", () => {
        const result = reduce(
          timerSignal({
            kind: "dispatch_ack_expired",
            dispatchId: "d-1" as DispatchId,
            consecutiveFailures: 5,
          }),
          implementing(),
        );
        expectEvent(result, "exhausted_retries");
      });

      it("high consecutive failures in gating → exhausted_retries", () => {
        const result = reduce(
          timerSignal({
            kind: "dispatch_ack_expired",
            dispatchId: "d-1" as DispatchId,
            consecutiveFailures: 10,
          }),
          gating("ci"),
        );
        expectEvent(result, "exhausted_retries");
      });
    });

    it("babysit_due → null", () => {
      const result = reduce(
        timerSignal({ kind: "babysit_due" }),
        babysitting(),
      );
      expect(result).toBeNull();
    });

    it("heartbeat_check → null", () => {
      const result = reduce(
        timerSignal({ kind: "heartbeat_check" }),
        implementing(),
      );
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Babysit signals
  // ---------------------------------------------------------------------------

  describe("babysit signals", () => {
    describe("babysit_gates_passed", () => {
      it("babysitting → babysit_passed", () => {
        const result = reduce(
          babysitSignal({ kind: "babysit_gates_passed", headSha: "sha1" }),
          babysitting(),
        );
        expectEvent(result, "babysit_passed");
      });

      it("implementing → null", () => {
        const result = reduce(
          babysitSignal({ kind: "babysit_gates_passed", headSha: "sha1" }),
          implementing(),
        );
        expect(result).toBeNull();
      });

      it("planning → null", () => {
        const result = reduce(
          babysitSignal({ kind: "babysit_gates_passed", headSha: "sha1" }),
          planning(),
        );
        expect(result).toBeNull();
      });
    });

    describe("babysit_gates_blocked", () => {
      it("babysitting → babysit_blocked", () => {
        const result = reduce(
          babysitSignal({ kind: "babysit_gates_blocked", headSha: "sha1" }),
          babysitting(),
        );
        expectEvent(result, "babysit_blocked");
      });

      it("implementing → null", () => {
        const result = reduce(
          babysitSignal({ kind: "babysit_gates_blocked", headSha: "sha1" }),
          implementing(),
        );
        expect(result).toBeNull();
      });

      it("gating → null", () => {
        const result = reduce(
          babysitSignal({ kind: "babysit_gates_blocked", headSha: "sha1" }),
          gating("ci"),
        );
        expect(result).toBeNull();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Signature-based circuit breaker
  // ---------------------------------------------------------------------------

  describe("failure signature circuit breaker", () => {
    it("returns signatureUpdate on daemon run_failed in implementing", () => {
      const result = reduce(
        daemonSignal({
          kind: "run_failed",
          runId: "r1",
          failure: { kind: "runtime_crash", exitCode: 1, message: "crash" },
        }),
        implementing({ fixAttemptCount: 0, maxFixAttempts: 5 }),
      );
      expect(result).not.toBeNull();
      expect(result).toHaveProperty("signatureUpdate");
      const r = result as { signatureUpdate: Record<string, unknown> };
      expect(Object.keys(r.signatureUpdate)).toHaveLength(1);
    });

    it("trips circuit breaker after maxConsecutive runtime_crash (3)", () => {
      const failure = {
        kind: "runtime_crash" as const,
        exitCode: 1,
        message: "same crash",
      };
      const now = new Date();
      let map: FailureSignatureMap = {};
      // Simulate 2 prior failures
      ({ updatedMap: map } = extractFailureSignature(
        failure,
        "daemon",
        map,
        now,
      ));
      ({ updatedMap: map } = extractFailureSignature(
        failure,
        "daemon",
        map,
        now,
      ));

      // Third failure should trip the breaker
      const wf = implementing({
        fixAttemptCount: 0,
        maxFixAttempts: 10,
      });
      const wfWithSigs = { ...wf, failureSignatures: map };
      const result = reduce(
        daemonSignal({
          kind: "run_failed",
          runId: "r1",
          failure,
        }),
        wfWithSigs as DeliveryWorkflow,
      );
      expectEvent(result, "exhausted_retries");
    });

    it("infra failure (Internal error) uses infra policy with higher limits", () => {
      const result = reduce(
        daemonSignal({
          kind: "run_failed",
          runId: "r1",
          failure: {
            kind: "runtime_crash",
            exitCode: null,
            message: "Internal error",
          },
        }),
        implementing({ fixAttemptCount: 4, maxFixAttempts: 5 }),
      );
      // Infra failures bypass fix budget, first occurrence should redispatch
      expectEvent(result, "redispatch_requested");
      expect(result).toHaveProperty("signatureUpdate");
    });

    it("infra failure trips after 10 consecutive", () => {
      const failure = {
        kind: "runtime_crash" as const,
        exitCode: null,
        message: "Internal error",
      };
      const now = new Date();
      let map: FailureSignatureMap = {};
      // Simulate 9 prior infra failures
      for (let i = 0; i < 9; i++) {
        ({ updatedMap: map } = extractFailureSignature(
          failure,
          "daemon",
          map,
          now,
        ));
      }
      const wf = implementing({ fixAttemptCount: 0, maxFixAttempts: 5 });
      const wfWithSigs = { ...wf, failureSignatures: map };

      const result = reduce(
        daemonSignal({ kind: "run_failed", runId: "r1", failure }),
        wfWithSigs as DeliveryWorkflow,
      );
      expectEvent(result, "exhausted_retries");
    });

    it("config_error trips immediately (maxConsecutive=1)", () => {
      const result = reduce(
        daemonSignal({
          kind: "run_failed",
          runId: "r1",
          failure: { kind: "config_error", message: "bad config" },
        }),
        implementing({ fixAttemptCount: 0, maxFixAttempts: 5 }),
      );
      expectEvent(result, "exhausted_retries");
    });

    it("oom trips after 2 consecutive", () => {
      const failure = { kind: "oom" as const, durationMs: 30000 };
      const now = new Date();
      let map: FailureSignatureMap = {};
      ({ updatedMap: map } = extractFailureSignature(
        failure,
        "daemon",
        map,
        now,
      ));
      const wf = implementing({ fixAttemptCount: 0, maxFixAttempts: 10 });
      const wfWithSigs = { ...wf, failureSignatures: map };

      const result = reduce(
        daemonSignal({ kind: "run_failed", runId: "r1", failure }),
        wfWithSigs as DeliveryWorkflow,
      );
      expectEvent(result, "exhausted_retries");
    });

    it("different failure messages create separate signatures", () => {
      const result1 = reduce(
        daemonSignal({
          kind: "run_failed",
          runId: "r1",
          failure: { kind: "runtime_crash", exitCode: 1, message: "crash A" },
        }),
        implementing({ fixAttemptCount: 0, maxFixAttempts: 5 }),
      );
      expect(result1).toHaveProperty("signatureUpdate");
      const map1 = (result1 as { signatureUpdate: Record<string, unknown> })
        .signatureUpdate;
      expect(Object.keys(map1)).toHaveLength(1);

      // Different message creates a second entry
      const wfWithSigs = {
        ...implementing({ fixAttemptCount: 0, maxFixAttempts: 5 }),
        failureSignatures: map1,
      };
      const result2 = reduce(
        daemonSignal({
          kind: "run_failed",
          runId: "r1",
          failure: { kind: "runtime_crash", exitCode: 1, message: "crash B" },
        }),
        wfWithSigs as DeliveryWorkflow,
      );
      const map2 = (result2 as { signatureUpdate: Record<string, unknown> })
        .signatureUpdate;
      expect(Object.keys(map2)).toHaveLength(2);
    });
  });
});
