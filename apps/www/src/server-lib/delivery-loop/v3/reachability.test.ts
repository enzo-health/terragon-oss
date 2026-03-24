import { describe, expect, it } from "vitest";
import { reduce } from "./reducer";
import type { WorkflowHead, LoopEvent, WorkflowState } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-03-18T00:00:00.000Z");

function makeHead(state: WorkflowState): WorkflowHead {
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

const ALL_STATES: WorkflowState[] = [
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

const NON_TERMINAL_STATES: WorkflowState[] = [
  "planning",
  "implementing",
  "gating_review",
  "gating_ci",
  "awaiting_pr",
  "awaiting_manual_fix",
  "awaiting_operator_action",
];

const TERMINAL_STATES = new Set<WorkflowState>([
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

function canReachTerminal(startState: WorkflowState): {
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
  for (const state of ["done", "stopped", "terminated"] as WorkflowState[]) {
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
// WorkflowState = transitions to that state
type Expectation = {
  target: WorkflowState | "noop" | "stay";
  effects?: string[];
};

const EVENT_TYPES = ALL_CANONICAL_EVENTS.map((e) => e.type);

const EXPECTED: Record<WorkflowState, Record<string, Expectation>> = {
  // -- planning --
  planning: {
    bootstrap: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    planning_run_completed: {
      target: "stay",
      effects: ["create_plan_artifact", "publish_status"],
    },
    plan_completed: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    plan_failed: {
      target: "awaiting_manual_fix",
      effects: ["publish_status"],
    },
    dispatch_sent: {
      target: "implementing",
      effects: ["ack_timeout_check"],
    },
    dispatch_acked: { target: "noop", effects: [] },
    dispatch_ack_timeout: { target: "noop", effects: [] },
    run_completed: { target: "noop", effects: [] },
    run_failed: { target: "noop", effects: [] },
    gate_review_passed: { target: "noop", effects: [] },
    gate_review_failed: { target: "noop", effects: [] },
    gate_ci_passed: { target: "noop", effects: [] },
    gate_ci_failed: { target: "noop", effects: [] },
    pr_linked: { target: "noop", effects: [] },
    resume_requested: { target: "noop", effects: [] },
    stop_requested: { target: "stopped", effects: ["publish_status"] },
    pr_closed: { target: "terminated", effects: ["publish_status"] },
  },
  // -- implementing (activeRunId = "r-1", fresh retry counts) --
  implementing: {
    bootstrap: { target: "noop", effects: [] },
    planning_run_completed: { target: "noop", effects: [] },
    plan_completed: { target: "noop", effects: [] },
    plan_failed: { target: "noop", effects: [] },
    dispatch_sent: {
      target: "stay",
      effects: ["ack_timeout_check"],
    },
    dispatch_acked: { target: "stay", effects: [] },
    dispatch_ack_timeout: {
      // infra retry (first attempt, under budget) -> stays implementing
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    run_completed: {
      target: "gating_review",
      effects: ["dispatch_gate_review", "publish_status"],
    },
    run_failed: {
      // agent retry (first attempt, under budget)
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    gate_review_passed: { target: "noop", effects: [] },
    gate_review_failed: { target: "noop", effects: [] },
    gate_ci_passed: { target: "noop", effects: [] },
    gate_ci_failed: { target: "noop", effects: [] },
    pr_linked: { target: "noop", effects: [] },
    resume_requested: { target: "noop", effects: [] },
    stop_requested: { target: "stopped", effects: ["publish_status"] },
    pr_closed: { target: "terminated", effects: ["publish_status"] },
  },
  // -- gating_review (activeRunId = "r-1", headSha = "abc123") --
  gating_review: {
    bootstrap: { target: "noop", effects: [] },
    planning_run_completed: { target: "noop", effects: [] },
    plan_completed: { target: "noop", effects: [] },
    plan_failed: { target: "noop", effects: [] },
    dispatch_sent: {
      target: "stay",
      effects: ["ack_timeout_check"],
    },
    dispatch_acked: { target: "stay", effects: [] },
    dispatch_ack_timeout: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    run_completed: { target: "noop", effects: [] },
    run_failed: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    gate_review_passed: {
      // prNumber=1 provided -> has PR -> gating_ci
      target: "gating_ci",
      effects: ["gate_staleness_check", "publish_status"],
    },
    gate_review_failed: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    gate_ci_passed: { target: "noop", effects: [] },
    gate_ci_failed: { target: "noop", effects: [] },
    pr_linked: { target: "noop", effects: [] },
    resume_requested: { target: "noop", effects: [] },
    stop_requested: { target: "stopped", effects: ["publish_status"] },
    pr_closed: { target: "terminated", effects: ["publish_status"] },
  },
  // -- gating_ci (headSha = "abc123") --
  gating_ci: {
    bootstrap: { target: "noop", effects: [] },
    planning_run_completed: { target: "noop", effects: [] },
    plan_completed: { target: "noop", effects: [] },
    plan_failed: { target: "noop", effects: [] },
    dispatch_sent: { target: "noop", effects: [] },
    dispatch_acked: { target: "noop", effects: [] },
    dispatch_ack_timeout: { target: "noop", effects: [] },
    run_completed: { target: "noop", effects: [] },
    run_failed: { target: "noop", effects: [] },
    gate_review_passed: { target: "noop", effects: [] },
    gate_review_failed: { target: "noop", effects: [] },
    gate_ci_passed: {
      target: "awaiting_pr",
      effects: ["publish_status"],
    },
    gate_ci_failed: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    pr_linked: { target: "noop", effects: [] },
    resume_requested: { target: "noop", effects: [] },
    stop_requested: { target: "stopped", effects: ["publish_status"] },
    pr_closed: { target: "terminated", effects: ["publish_status"] },
  },
  // -- awaiting_pr (blockedReason = "Awaiting PR creation") --
  awaiting_pr: {
    bootstrap: { target: "noop", effects: [] },
    planning_run_completed: { target: "noop", effects: [] },
    plan_completed: { target: "noop", effects: [] },
    plan_failed: { target: "noop", effects: [] },
    dispatch_sent: { target: "noop", effects: [] },
    dispatch_acked: { target: "noop", effects: [] },
    dispatch_ack_timeout: { target: "noop", effects: [] },
    run_completed: { target: "noop", effects: [] },
    run_failed: { target: "noop", effects: [] },
    gate_review_passed: { target: "noop", effects: [] },
    gate_review_failed: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    gate_ci_passed: { target: "noop", effects: [] },
    gate_ci_failed: { target: "noop", effects: [] },
    pr_linked: {
      target: "gating_ci",
      effects: ["gate_staleness_check", "publish_status"],
    },
    resume_requested: { target: "noop", effects: [] },
    stop_requested: { target: "stopped", effects: ["publish_status"] },
    pr_closed: { target: "terminated", effects: ["publish_status"] },
  },
  // -- awaiting_manual_fix --
  awaiting_manual_fix: {
    bootstrap: { target: "noop", effects: [] },
    planning_run_completed: { target: "noop", effects: [] },
    plan_completed: { target: "noop", effects: [] },
    plan_failed: { target: "noop", effects: [] },
    dispatch_sent: { target: "noop", effects: [] },
    dispatch_acked: { target: "noop", effects: [] },
    dispatch_ack_timeout: { target: "noop", effects: [] },
    run_completed: { target: "noop", effects: [] },
    run_failed: { target: "noop", effects: [] },
    gate_review_passed: { target: "noop", effects: [] },
    gate_review_failed: { target: "noop", effects: [] },
    gate_ci_passed: { target: "noop", effects: [] },
    gate_ci_failed: { target: "noop", effects: [] },
    pr_linked: { target: "noop", effects: [] },
    resume_requested: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    stop_requested: { target: "stopped", effects: ["publish_status"] },
    pr_closed: { target: "terminated", effects: ["publish_status"] },
  },
  // -- awaiting_operator_action --
  awaiting_operator_action: {
    bootstrap: { target: "noop", effects: [] },
    planning_run_completed: { target: "noop", effects: [] },
    plan_completed: { target: "noop", effects: [] },
    plan_failed: { target: "noop", effects: [] },
    dispatch_sent: { target: "noop", effects: [] },
    dispatch_acked: { target: "noop", effects: [] },
    dispatch_ack_timeout: { target: "noop", effects: [] },
    run_completed: { target: "noop", effects: [] },
    run_failed: { target: "noop", effects: [] },
    gate_review_passed: { target: "noop", effects: [] },
    gate_review_failed: { target: "noop", effects: [] },
    gate_ci_passed: { target: "noop", effects: [] },
    gate_ci_failed: { target: "noop", effects: [] },
    pr_linked: { target: "noop", effects: [] },
    resume_requested: {
      target: "implementing",
      effects: ["dispatch_implementing", "publish_status"],
    },
    stop_requested: { target: "stopped", effects: ["publish_status"] },
    pr_closed: { target: "terminated", effects: ["publish_status"] },
  },
  // -- terminal states (all absorb) --
  done: Object.fromEntries(
    EVENT_TYPES.map((t) => [t, { target: "noop", effects: [] }]),
  ) as Record<string, Expectation>,
  stopped: Object.fromEntries(
    EVENT_TYPES.map((t) => [t, { target: "noop", effects: [] }]),
  ) as Record<string, Expectation>,
  terminated: Object.fromEntries(
    EVENT_TYPES.map((t) => [t, { target: "noop", effects: [] }]),
  ) as Record<string, Expectation>,
};

describe("exhaustive (state x event) transition table", () => {
  for (const state of ALL_STATES) {
    describe(state, () => {
      const expectations = EXPECTED[state]!;
      for (const event of ALL_CANONICAL_EVENTS) {
        const cell = expectations[event.type]!;
        it(`${event.type} -> ${cell.target}`, () => {
          const head = makeHead(state);
          const result = reduce({ head, event, now: NOW });

          if (cell.target === "noop") {
            // Fully ignored: same state, same version
            expect(result.head.state).toBe(state);
            expect(result.head.version).toBe(head.version);
          } else if (cell.target === "stay") {
            // Acknowledged but stays in same state; version must bump
            expect(result.head.state).toBe(state);
            expect(result.head.version).toBeGreaterThan(head.version);
          } else {
            // Transitions to a different state
            expect(result.head.state).toBe(cell.target);
          }

          // Check emitted effect kinds
          expect(result.effects.map((e) => e.kind)).toEqual(cell.effects ?? []);
        });
      }
    });
  }
});
