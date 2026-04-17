import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reduce } from "./reducer";
import type { LoopEvent, WorkflowHead, WorkflowState } from "./types";

// ─── Constants ───────────────────────────────────────────────────────────────

const ALL_STATES: WorkflowState[] = [
  "planning",
  "implementing",
  "gating_review",
  "gating_ci",
  "awaiting_pr_creation",
  "awaiting_pr_lifecycle",
  "awaiting_manual_fix",
  "awaiting_operator_action",
  "done",
  "stopped",
  "terminated",
];

const TERMINAL_STATES: WorkflowState[] = ["done", "stopped", "terminated"];

// States where activeRunId is allowed to be non-null (DISPATCH_COHERENT_STATES in reducer)
const DISPATCH_COHERENT_STATES = new Set<WorkflowState>([
  "planning",
  "implementing",
  "gating_review",
  "gating_ci",
]);

const now = new Date("2026-01-01T00:00:00Z");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeHead(overrides: Partial<WorkflowHead> = {}): WorkflowHead {
  return {
    workflowId: "wf-test",
    threadId: "th-test",
    generation: 1,
    version: 1,
    state: "planning",
    activeRunId: null,
    activeRunSeq: null,
    leaseExpiresAt: null,
    lastTerminalRunSeq: null,
    activeGate: null,
    headSha: null,
    blockedReason: null,
    fixAttemptCount: 0,
    infraRetryCount: 0,
    maxFixAttempts: 5,
    maxInfraRetries: 5,
    narrationOnlyRetryCount: 0,
    lastResurrectedAt: null,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    ...overrides,
  };
}

function expectedGateForState(state: WorkflowState): string | null {
  if (state === "gating_review") return "review";
  if (state === "gating_ci") return "ci";
  return null;
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const runIdArb = fc.stringMatching(/^[0-9a-f]{8}$/);
const headShaArb = fc.stringMatching(/^[0-9a-f]{40}$/);

const loopEventArb: fc.Arbitrary<LoopEvent> = fc.oneof(
  fc.constant<LoopEvent>({ type: "bootstrap" }),
  fc.constant<LoopEvent>({ type: "planning_run_completed" }),
  fc.constant<LoopEvent>({ type: "plan_completed" }),
  fc.record<Extract<LoopEvent, { type: "plan_failed" }>>({
    type: fc.constant("plan_failed"),
    reason: fc.constant("test failure"),
  }),
  fc.record<Extract<LoopEvent, { type: "dispatch_sent" }>>({
    type: fc.constant("dispatch_sent"),
    runId: runIdArb,
  }),
  fc.record<Extract<LoopEvent, { type: "dispatch_acked" }>>({
    type: fc.constant("dispatch_acked"),
    runId: runIdArb,
  }),
  fc.record<Extract<LoopEvent, { type: "dispatch_ack_timeout" }>>({
    type: fc.constant("dispatch_ack_timeout"),
    runId: runIdArb,
  }),
  // run_completed with headSha
  fc
    .record({ runId: runIdArb, headSha: headShaArb })
    .map<LoopEvent>(({ runId, headSha }) => ({
      type: "run_completed",
      runId,
      headSha,
    })),
  // run_completed without headSha (triggers retry path)
  fc.record({ runId: runIdArb }).map<LoopEvent>(({ runId }) => ({
    type: "run_completed",
    runId,
    headSha: null,
  })),
  fc
    .record({
      runId: runIdArb,
      message: fc.constant("err"),
      category: fc.constant<string | null>(null),
    })
    .map<LoopEvent>(({ runId, message, category }) => ({
      type: "run_failed",
      runId,
      message,
      category,
    })),
  fc
    .record({
      runId: fc.oneof(runIdArb, fc.constant<string | null>(null)),
      prNumber: fc.oneof(
        fc.integer({ min: 1, max: 9999 }),
        fc.constant<number | null>(null),
      ),
    })
    .map<LoopEvent>(({ runId, prNumber }) => ({
      type: "gate_review_passed",
      runId,
      prNumber,
    })),
  fc
    .record({
      runId: fc.oneof(runIdArb, fc.constant<string | null>(null)),
      reason: fc.constant<string | null>("review failed"),
    })
    .map<LoopEvent>(({ runId, reason }) => ({
      type: "gate_review_failed",
      runId,
      reason,
    })),
  fc
    .record({
      runId: fc.oneof(runIdArb, fc.constant<string | null>(null)),
      headSha: fc.oneof(headShaArb, fc.constant<string | null>(null)),
    })
    .map<LoopEvent>(({ runId, headSha }) => ({
      type: "gate_ci_passed",
      runId,
      headSha,
    })),
  fc
    .record({
      runId: fc.oneof(runIdArb, fc.constant<string | null>(null)),
      headSha: fc.oneof(headShaArb, fc.constant<string | null>(null)),
      reason: fc.constant<string | null>("ci failed"),
    })
    .map<LoopEvent>(({ runId, headSha, reason }) => ({
      type: "gate_ci_failed",
      runId,
      headSha,
      reason,
    })),
  fc
    .record({
      prNumber: fc.oneof(
        fc.integer({ min: 1, max: 9999 }),
        fc.constant<number | null>(null),
      ),
    })
    .map<LoopEvent>(({ prNumber }) => ({ type: "pr_linked", prNumber })),
  fc.constant<LoopEvent>({ type: "resume_requested" }),
  fc.constant<LoopEvent>({ type: "stop_requested" }),
  fc.boolean().map<LoopEvent>((merged) => ({ type: "pr_closed", merged })),
);

const stateArb = fc.constantFrom(...ALL_STATES);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("reducer invariants (property-based)", () => {
  it("invariants hold for random event sequences from any initial state", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.array(loopEventArb, { minLength: 1, maxLength: 50 }),
        (initialState, events) => {
          let head = makeHead({ state: initialState });

          for (const event of events) {
            const result = reduce({ head, event, now });

            // activeGate must always match state after middleware
            expect(result.head.activeGate).toBe(
              expectedGateForState(result.head.state),
            );

            // activeRunId only allowed in dispatch-coherent states
            if (!DISPATCH_COHERENT_STATES.has(result.head.state)) {
              expect(result.head.activeRunId).toBeNull();
            }

            // version must be >= previous version
            expect(result.head.version).toBeGreaterThanOrEqual(head.version);

            // effects must be an array
            expect(Array.isArray(result.effects)).toBe(true);

            head = result.head;
          }
        },
      ),
    );
  });

  it("terminal states are absorbing — no event changes them", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TERMINAL_STATES),
        fc.array(loopEventArb, { minLength: 1, maxLength: 20 }),
        (terminalState, events) => {
          let head = makeHead({ state: terminalState });

          for (const event of events) {
            const result = reduce({ head, event, now });
            expect(result.head.state).toBe(terminalState);
            expect(result.effects).toHaveLength(0);
            head = result.head;
          }
        },
      ),
    );
  });

  it("stop_requested always reaches stopped from any non-terminal state", () => {
    const nonTerminalStates = ALL_STATES.filter(
      (s) => !TERMINAL_STATES.includes(s),
    );
    fc.assert(
      fc.property(fc.constantFrom(...nonTerminalStates), (initialState) => {
        const head = makeHead({ state: initialState });
        const result = reduce({
          head,
          event: { type: "stop_requested" },
          now,
        });
        expect(result.head.state).toBe("stopped");
      }),
    );
  });

  it("pr_closed always reaches terminated from any non-terminal state", () => {
    const nonTerminalStates = ALL_STATES.filter(
      (s) => !TERMINAL_STATES.includes(s),
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...nonTerminalStates),
        fc.boolean(),
        (initialState, merged) => {
          const head = makeHead({ state: initialState });
          const result = reduce({
            head,
            event: { type: "pr_closed", merged },
            now,
          });
          expect(result.head.state).toBe("terminated");
        },
      ),
    );
  });

  it("version never decreases across a random event sequence", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.array(loopEventArb, { minLength: 1, maxLength: 50 }),
        (initialState, events) => {
          let head = makeHead({ state: initialState });
          let prevVersion = head.version;

          for (const event of events) {
            const result = reduce({ head, event, now });
            expect(result.head.version).toBeGreaterThanOrEqual(prevVersion);
            prevVersion = result.head.version;
            head = result.head;
          }
        },
      ),
    );
  });

  it("activeRunId is null outside dispatch-coherent states after every reduce", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.array(loopEventArb, { minLength: 1, maxLength: 30 }),
        (initialState, events) => {
          let head = makeHead({ state: initialState });

          for (const event of events) {
            const result = reduce({ head, event, now });
            if (!DISPATCH_COHERENT_STATES.has(result.head.state)) {
              expect(result.head.activeRunId).toBeNull();
            }
            head = result.head;
          }
        },
      ),
    );
  });

  it("activeGate always matches state: gating_review→'review', gating_ci→'ci', else→null", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.array(loopEventArb, { minLength: 1, maxLength: 30 }),
        (initialState, events) => {
          let head = makeHead({ state: initialState });

          for (const event of events) {
            const result = reduce({ head, event, now });
            expect(result.head.activeGate).toBe(
              expectedGateForState(result.head.state),
            );
            head = result.head;
          }
        },
      ),
    );
  });

  it("dispatch_acked never changes state", () => {
    fc.assert(
      fc.property(stateArb, runIdArb, (initialState, runId) => {
        // Set activeRunId to match or mismatch — either way state must not change
        const headWithRun = makeHead({
          state: initialState,
          activeRunId: runId,
        });
        const headWithoutRun = makeHead({
          state: initialState,
          activeRunId: null,
        });

        for (const head of [headWithRun, headWithoutRun]) {
          const result = reduce({
            head,
            event: { type: "dispatch_acked", runId },
            now,
          });
          expect(result.head.state).toBe(initialState);
        }
      }),
    );
  });

  it("retry budgets are never negative after any event sequence", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.array(loopEventArb, { minLength: 1, maxLength: 50 }),
        (initialState, events) => {
          let head = makeHead({ state: initialState });

          for (const event of events) {
            const result = reduce({ head, event, now });
            expect(result.head.fixAttemptCount).toBeGreaterThanOrEqual(0);
            expect(result.head.infraRetryCount).toBeGreaterThanOrEqual(0);
            head = result.head;
          }
        },
      ),
    );
  });

  it("activeRunSeq stays ahead of the last consumed lease after any event sequence", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.array(loopEventArb, { minLength: 1, maxLength: 50 }),
        (initialState, events) => {
          let head = makeHead({ state: initialState });

          for (const event of events) {
            const result = reduce({ head, event, now });

            if (
              result.head.activeRunSeq !== null &&
              result.head.lastTerminalRunSeq !== null
            ) {
              expect(result.head.activeRunSeq).toBeGreaterThan(
                result.head.lastTerminalRunSeq,
              );
            }

            head = result.head;
          }
        },
      ),
    );
  });

  it("stale terminal run signals do not consume the active lease", () => {
    const head = makeHead({
      state: "implementing",
      activeRunId: "run-current",
      activeRunSeq: 7,
    });

    const result = reduce({
      head,
      event: {
        type: "run_completed",
        runId: "run-stale",
        headSha: "sha-stale",
      },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.head.activeRunId).toBe("run-current");
    expect(result.head.activeRunSeq).toBe(7);
    expect(result.head.lastTerminalRunSeq).toBeNull();
    expect(result.effects).toHaveLength(0);
  });

  it("mismatched runSeq gate verdicts are no-ops", () => {
    const head = makeHead({
      state: "gating_review",
      activeGate: "review",
      activeRunId: "run-current",
      activeRunSeq: 3,
    });

    const result = reduce({
      head,
      event: {
        type: "gate_review_passed",
        runId: "run-current",
        runSeq: 4,
        prNumber: 42,
      },
      now,
    });

    expect(result.head.state).toBe("gating_review");
    expect(result.head.activeRunSeq).toBe(3);
    expect(result.effects).toHaveLength(0);
  });

  it("gating_ci + run_failed retries to implementing or stays if runId guard blocks", () => {
    fc.assert(
      fc.property(
        runIdArb,
        runIdArb,
        fc.constantFrom<"agent" | "infra">("agent", "infra"),
        (activeRunId, eventRunId, lane) => {
          const head = makeHead({
            state: "gating_ci",
            activeRunId,
            activeGate: "ci",
          });
          const result = reduce({
            head,
            event: {
              type: "run_failed",
              runId: eventRunId,
              message: "err",
              category: null,
              lane,
            },
            now,
          });

          const isOutOfOrder =
            activeRunId !== null && eventRunId !== activeRunId;

          if (isOutOfOrder) {
            // runId guard blocks — state unchanged
            expect(result.head.state).toBe("gating_ci");
          } else {
            // retries to implementing or exhausts budget
            expect(
              result.head.state === "implementing" ||
                result.head.state === "awaiting_manual_fix" ||
                result.head.state === "awaiting_operator_action",
            ).toBe(true);
          }
        },
      ),
    );
  });

  it("entering gating_ci always emits a gate_staleness_check effect", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.array(loopEventArb, { minLength: 1, maxLength: 30 }),
        (initialState, events) => {
          let head = makeHead({ state: initialState });

          for (const event of events) {
            const result = reduce({ head, event, now });

            // If we just transitioned INTO gating_ci, effects must include gate_staleness_check
            if (
              head.state !== "gating_ci" &&
              result.head.state === "gating_ci"
            ) {
              const hasStalenessCheck = result.effects.some(
                (e) => e.kind === "gate_staleness_check",
              );
              expect(hasStalenessCheck).toBe(true);
            }

            head = result.head;
          }
        },
      ),
    );
  });
});
