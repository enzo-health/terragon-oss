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

// ---------------------------------------------------------------------------
// Helpers — workflow snapshot builders
// ---------------------------------------------------------------------------

const COMMON = {
  workflowId: "wf-1" as WorkflowId,
  threadId: "th-1" as ThreadId,
  generation: 1,
  version: 1,
  fixAttemptCount: 0,
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
      it("planning state → null (checkpoint handles it)", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_completed",
            runId: "r1",
            result: { kind: "success", headSha: "sha1", summary: "done" },
          }),
          planning(),
        );
        expect(result).toBeNull();
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

      it("planning → null", () => {
        const result = reduce(
          daemonSignal({
            kind: "run_failed",
            runId: "r1",
            failure: { kind: "runtime_crash", exitCode: 1, message: "crash" },
          }),
          planning(),
        );
        expect(result).toBeNull();
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
      it("<= 5 consecutive failures → gate_blocked", () => {
        const result = reduce(
          timerSignal({
            kind: "dispatch_ack_expired",
            dispatchId: "d-1" as DispatchId,
            consecutiveFailures: 3,
          }),
          implementing(),
        );
        expectEvent(result, "gate_blocked");
      });

      it("default (no consecutiveFailures) → gate_blocked", () => {
        const result = reduce(
          timerSignal({
            kind: "dispatch_ack_expired",
            dispatchId: "d-1" as DispatchId,
          }),
          implementing(),
        );
        expectEvent(result, "gate_blocked");
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
});
