import { describe, expect, it } from "vitest";
import { reduce } from "./reducer";
import type { WorkflowHead, LoopEvent, WorkflowStateV3 } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-03-18T00:00:00.000Z");

function makeHead(state: WorkflowStateV3): WorkflowHead {
  const base: WorkflowHead = {
    workflowId: "wf-1",
    threadId: "thread-1",
    generation: 1,
    version: 2,
    state,
    activeGate: null,
    headSha: null,
    activeRunId: null,
    fixAttemptCount: 0,
    infraRetryCount: 0,
    maxFixAttempts: 6,
    maxInfraRetries: 10,
    blockedReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastActivityAt: NOW,
  };

  switch (state) {
    case "implementing":
      return { ...base, activeRunId: "r-1" };
    case "gating_review":
      return {
        ...base,
        activeRunId: "r-1",
        headSha: "abc123",
        activeGate: "review",
      };
    case "gating_ci":
      return { ...base, headSha: "abc123", activeGate: "ci" };
    case "awaiting_pr":
      return {
        ...base,
        headSha: "abc123",
        blockedReason: "Awaiting PR creation",
      };
    case "awaiting_manual_fix":
      return { ...base, blockedReason: "test" };
    case "awaiting_operator_action":
      return { ...base, blockedReason: "test" };
    default:
      return base;
  }
}

const ALL_STATES: WorkflowStateV3[] = [
  "planning",
  "implementing",
  "gating_review",
  "gating_ci",
  "awaiting_pr",
  "awaiting_manual_fix",
  "awaiting_operator_action",
  "done",
  "stopped",
  "terminated",
];

const NON_TERMINAL_STATES: WorkflowStateV3[] = [
  "planning",
  "implementing",
  "gating_review",
  "gating_ci",
  "awaiting_pr",
  "awaiting_manual_fix",
  "awaiting_operator_action",
];

const TERMINAL_STATES = new Set<WorkflowStateV3>([
  "done",
  "stopped",
  "terminated",
]);

const ALL_CANONICAL_EVENTS: LoopEvent[] = [
  { type: "bootstrap" },
  { type: "planning_run_completed" },
  { type: "plan_completed" },
  { type: "plan_failed", reason: "test" },
  {
    type: "dispatch_sent",
    runId: "r-1",
    ackDeadlineAt: new Date("2030-01-01"),
  },
  { type: "dispatch_acked", runId: "r-1" },
  { type: "dispatch_ack_timeout", runId: "r-1" },
  { type: "run_completed", runId: "r-1", headSha: "abc123" },
  { type: "run_failed", runId: "r-1", message: "err", category: null },
  { type: "gate_review_passed", runId: "r-1", prNumber: 1 },
  { type: "gate_review_failed", runId: "r-1", reason: "test" },
  { type: "gate_ci_passed", headSha: "abc123" },
  { type: "gate_ci_failed", headSha: "abc123", reason: "test" },
  { type: "pr_linked", prNumber: 1 },
  { type: "resume_requested" },
  { type: "stop_requested" },
  { type: "pr_closed", merged: false },
];

// ---------------------------------------------------------------------------
// Suite 1: BFS Reachability
// ---------------------------------------------------------------------------

function canReachTerminal(startState: WorkflowStateV3): {
  reachable: boolean;
  path: string[];
} {
  const queue: { head: WorkflowHead; path: string[] }[] = [
    { head: makeHead(startState), path: [startState] },
  ];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { head, path } = queue.shift()!;
    if (TERMINAL_STATES.has(head.state)) return { reachable: true, path };
    if (visited.has(head.state)) continue;
    visited.add(head.state);

    for (const event of ALL_CANONICAL_EVENTS) {
      const result = reduce({ head: makeHead(head.state), event, now: NOW });
      if (result.head.state !== head.state) {
        queue.push({
          head: result.head,
          path: [...path, `--${event.type}-->`, result.head.state],
        });
      }
    }
  }
  return { reachable: false, path: [] };
}

describe("BFS reachability", () => {
  for (const state of NON_TERMINAL_STATES) {
    it(`${state} can reach a terminal state`, () => {
      const result = canReachTerminal(state);
      expect(result.reachable).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Suite 2: Terminal State Absorption
// ---------------------------------------------------------------------------

describe("terminal state absorption", () => {
  for (const state of ["done", "stopped", "terminated"] as WorkflowStateV3[]) {
    it(`${state} absorbs all events`, () => {
      for (const event of ALL_CANONICAL_EVENTS) {
        const result = reduce({ head: makeHead(state), event, now: NOW });
        expect(result.head.state).toBe(state);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Suite 3: Exhaustive (state x event) transition table
// ---------------------------------------------------------------------------

// "noop" = state unchanged AND version unchanged (event fully ignored)
// "stay"  = state unchanged but version bumped (event acknowledged)
// WorkflowStateV3 = transitions to that state
type Expectation = WorkflowStateV3 | "noop" | "stay";

const EVENT_TYPES = ALL_CANONICAL_EVENTS.map((e) => e.type);

const EXPECTED: Record<WorkflowStateV3, Record<string, Expectation>> = {
  // -- planning --
  planning: {
    bootstrap: "implementing",
    planning_run_completed: "stay", // stays in planning, bumps version
    plan_completed: "implementing",
    plan_failed: "awaiting_manual_fix",
    dispatch_sent: "implementing",
    dispatch_acked: "noop",
    dispatch_ack_timeout: "noop",
    run_completed: "noop",
    run_failed: "noop",
    gate_review_passed: "noop",
    gate_review_failed: "noop",
    gate_ci_passed: "noop",
    gate_ci_failed: "noop",
    pr_linked: "noop",
    resume_requested: "noop",
    stop_requested: "stopped",
    pr_closed: "terminated",
  },
  // -- implementing (activeRunId = "r-1", fresh retry counts) --
  implementing: {
    bootstrap: "noop",
    planning_run_completed: "noop",
    plan_completed: "noop",
    plan_failed: "noop",
    dispatch_sent: "stay", // stays, updates activeRunId
    dispatch_acked: "stay", // stays, ack recorded
    dispatch_ack_timeout: "implementing", // infra retry -> stays implementing
    run_completed: "gating_review",
    run_failed: "implementing", // agent retry (first attempt, under budget)
    gate_review_passed: "noop",
    gate_review_failed: "noop",
    gate_ci_passed: "noop",
    gate_ci_failed: "noop",
    pr_linked: "noop",
    resume_requested: "noop",
    stop_requested: "stopped",
    pr_closed: "terminated",
  },
  // -- gating_review (activeRunId = "r-1", headSha = "abc123") --
  gating_review: {
    bootstrap: "noop",
    planning_run_completed: "noop",
    plan_completed: "noop",
    plan_failed: "noop",
    dispatch_sent: "stay", // updates activeRunId
    dispatch_acked: "stay", // ack recorded
    dispatch_ack_timeout: "implementing", // infra retry
    run_completed: "noop",
    run_failed: "implementing", // retry
    gate_review_passed: "gating_ci", // with prNumber=1
    gate_review_failed: "implementing", // agent retry
    gate_ci_passed: "noop",
    gate_ci_failed: "noop",
    pr_linked: "noop",
    resume_requested: "noop",
    stop_requested: "stopped",
    pr_closed: "terminated",
  },
  // -- gating_ci (headSha = "abc123") --
  gating_ci: {
    bootstrap: "noop",
    planning_run_completed: "noop",
    plan_completed: "noop",
    plan_failed: "noop",
    dispatch_sent: "noop",
    dispatch_acked: "noop",
    dispatch_ack_timeout: "noop",
    run_completed: "noop",
    run_failed: "noop",
    gate_review_passed: "noop",
    gate_review_failed: "noop",
    gate_ci_passed: "awaiting_pr",
    gate_ci_failed: "implementing", // agent retry
    pr_linked: "noop",
    resume_requested: "noop",
    stop_requested: "stopped",
    pr_closed: "terminated",
  },
  // -- awaiting_pr (blockedReason = "Awaiting PR creation") --
  awaiting_pr: {
    bootstrap: "noop",
    planning_run_completed: "noop",
    plan_completed: "noop",
    plan_failed: "noop",
    dispatch_sent: "noop",
    dispatch_acked: "noop",
    dispatch_ack_timeout: "noop",
    run_completed: "noop",
    run_failed: "noop",
    gate_review_passed: "noop",
    gate_review_failed: "implementing", // PR linkage failure -> retry
    gate_ci_passed: "noop",
    gate_ci_failed: "noop",
    pr_linked: "gating_ci",
    resume_requested: "noop",
    stop_requested: "stopped",
    pr_closed: "terminated",
  },
  // -- awaiting_manual_fix --
  awaiting_manual_fix: {
    bootstrap: "noop",
    planning_run_completed: "noop",
    plan_completed: "noop",
    plan_failed: "noop",
    dispatch_sent: "noop",
    dispatch_acked: "noop",
    dispatch_ack_timeout: "noop",
    run_completed: "noop",
    run_failed: "noop",
    gate_review_passed: "noop",
    gate_review_failed: "noop",
    gate_ci_passed: "noop",
    gate_ci_failed: "noop",
    pr_linked: "noop",
    resume_requested: "implementing",
    stop_requested: "stopped",
    pr_closed: "terminated",
  },
  // -- awaiting_operator_action --
  awaiting_operator_action: {
    bootstrap: "noop",
    planning_run_completed: "noop",
    plan_completed: "noop",
    plan_failed: "noop",
    dispatch_sent: "noop",
    dispatch_acked: "noop",
    dispatch_ack_timeout: "noop",
    run_completed: "noop",
    run_failed: "noop",
    gate_review_passed: "noop",
    gate_review_failed: "noop",
    gate_ci_passed: "noop",
    gate_ci_failed: "noop",
    pr_linked: "noop",
    resume_requested: "implementing",
    stop_requested: "stopped",
    pr_closed: "terminated",
  },
  // -- terminal states (all absorb) --
  done: Object.fromEntries(EVENT_TYPES.map((t) => [t, "noop"])) as Record<
    string,
    Expectation
  >,
  stopped: Object.fromEntries(EVENT_TYPES.map((t) => [t, "noop"])) as Record<
    string,
    Expectation
  >,
  terminated: Object.fromEntries(EVENT_TYPES.map((t) => [t, "noop"])) as Record<
    string,
    Expectation
  >,
};

describe("exhaustive (state x event) transition table", () => {
  for (const state of ALL_STATES) {
    describe(state, () => {
      const expectations = EXPECTED[state]!;
      for (const event of ALL_CANONICAL_EVENTS) {
        const expected = expectations[event.type];
        it(`${event.type} -> ${expected}`, () => {
          const head = makeHead(state);
          const result = reduce({ head, event, now: NOW });

          if (expected === "noop") {
            // Fully ignored: same state, same version
            expect(result.head.state).toBe(state);
            expect(result.head.version).toBe(head.version);
          } else if (expected === "stay") {
            // Acknowledged but stays in same state; version must bump
            expect(result.head.state).toBe(state);
            expect(result.head.version).toBeGreaterThan(head.version);
          } else {
            // Transitions to a different state
            expect(result.head.state).toBe(expected);
          }
        });
      }
    });
  }
});
