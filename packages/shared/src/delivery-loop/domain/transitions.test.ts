import { describe, it, expect } from "vitest";
import {
  reduceWorkflow,
  shouldResetFixAttemptCount,
  derivePendingAction,
} from "./transitions";
import type {
  DeliveryWorkflow,
  WorkflowCommon,
  WorkflowId,
  ThreadId,
  PlanVersion,
  DispatchId,
  GitSha,
  DispatchSubState,
  GateSubState,
  ResumableWorkflowState,
} from "./workflow";
import type { LoopEvent, LoopEventContext } from "./events";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-01-01T00:00:00Z");

function common(overrides?: Partial<WorkflowCommon>): WorkflowCommon {
  return {
    workflowId: "wf-1" as WorkflowId,
    threadId: "thread-1" as ThreadId,
    generation: 1,
    version: 0,
    fixAttemptCount: 0,
    infraRetryCount: 0,
    maxFixAttempts: 6,
    createdAt: new Date("2025-12-01"),
    updatedAt: new Date("2025-12-01"),
    lastActivityAt: null,
    ...overrides,
  };
}

function planning(
  overrides?: Partial<WorkflowCommon> & { planVersion?: PlanVersion | null },
): Extract<DeliveryWorkflow, { kind: "planning" }> {
  const { planVersion = 1 as PlanVersion, ...rest } = overrides ?? {};
  return { ...common(rest), kind: "planning", planVersion };
}

function implementing(
  overrides?: Partial<WorkflowCommon> & {
    planVersion?: PlanVersion;
    dispatch?: DispatchSubState;
  },
): Extract<DeliveryWorkflow, { kind: "implementing" }> {
  const {
    planVersion = 1 as PlanVersion,
    dispatch = {
      kind: "queued" as const,
      dispatchId: "d-1" as DispatchId,
      executionClass: "implementation_runtime" as const,
    },
    ...rest
  } = overrides ?? {};
  return { ...common(rest), kind: "implementing", planVersion, dispatch };
}

function gating(
  gate: GateSubState,
  overrides?: Partial<WorkflowCommon> & { headSha?: GitSha },
): Extract<DeliveryWorkflow, { kind: "gating" }> {
  const { headSha = "abc123" as GitSha, ...rest } = overrides ?? {};
  return { ...common(rest), kind: "gating", headSha, gate };
}

function reviewGate(): GateSubState {
  return {
    kind: "review",
    status: "waiting",
    runId: null,
    snapshot: { requiredApprovals: 0, approvalsReceived: 0, blockers: [] },
  };
}
function ciGate(): GateSubState {
  return {
    kind: "ci",
    status: "waiting",
    runId: null,
    snapshot: { checkSuites: [], failingRequiredChecks: [] },
  };
}
function uiGate(): GateSubState {
  return {
    kind: "ui",
    status: "waiting",
    runId: null,
    snapshot: { artifactUrl: null, blockers: [] },
  };
}

function awaitingPr(
  overrides?: Partial<WorkflowCommon>,
): Extract<DeliveryWorkflow, { kind: "awaiting_pr" }> {
  return {
    ...common(overrides),
    kind: "awaiting_pr",
    headSha: "abc" as GitSha,
  };
}

function babysitting(
  overrides?: Partial<WorkflowCommon>,
): Extract<DeliveryWorkflow, { kind: "babysitting" }> {
  return {
    ...common(overrides),
    kind: "babysitting",
    headSha: "abc" as GitSha,
    reviewSurface: { kind: "github_pr", prNumber: 42 },
    nextCheckAt: new Date("2026-01-01T00:05:00Z"),
  };
}

function awaitingPlanApproval(
  overrides?: Partial<WorkflowCommon>,
): Extract<DeliveryWorkflow, { kind: "awaiting_plan_approval" }> {
  return {
    ...common(overrides),
    kind: "awaiting_plan_approval",
    planVersion: 1 as PlanVersion,
    resumableFrom: { kind: "planning", planVersion: 1 as PlanVersion },
  };
}

function awaitingManualFix(
  resumableFrom?: Exclude<ResumableWorkflowState, { kind: "planning" }>,
  overrides?: Partial<WorkflowCommon>,
): Extract<DeliveryWorkflow, { kind: "awaiting_manual_fix" }> {
  return {
    ...common(overrides),
    kind: "awaiting_manual_fix",
    reason: {
      description: "Retry budget exhausted",
      suggestedAction: "Fix it",
    },
    resumableFrom: resumableFrom ?? {
      kind: "implementing",
      dispatchId: "d-1" as DispatchId,
      planVersion: 1 as PlanVersion,
    },
  };
}

function awaitingOperatorAction(
  resumableFrom?: ResumableWorkflowState,
  overrides?: Partial<WorkflowCommon>,
): Extract<DeliveryWorkflow, { kind: "awaiting_operator_action" }> {
  return {
    ...common(overrides),
    kind: "awaiting_operator_action",
    incidentId: "inc-1",
    reason: { description: "System failure", system: "daemon" },
    resumableFrom: resumableFrom ?? {
      kind: "implementing",
      dispatchId: "d-1" as DispatchId,
      planVersion: 1 as PlanVersion,
    },
  };
}

function done(): Extract<DeliveryWorkflow, { kind: "done" }> {
  return {
    ...common(),
    kind: "done",
    outcome: "completed",
    completedAt: NOW,
  };
}

function stopped(): Extract<DeliveryWorkflow, { kind: "stopped" }> {
  return {
    ...common(),
    kind: "stopped",
    reason: { kind: "user_requested" },
  };
}

function terminated(): Extract<DeliveryWorkflow, { kind: "terminated" }> {
  return {
    ...common(),
    kind: "terminated",
    reason: { kind: "pr_closed" },
  };
}

function reduce(
  snapshot: DeliveryWorkflow,
  event: LoopEvent,
  context: LoopEventContext = {},
) {
  return reduceWorkflow({ snapshot, event, context, now: NOW });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reduceWorkflow", () => {
  // -----------------------------------------------------------------------
  // Terminal states
  // -----------------------------------------------------------------------
  describe("terminal states reject all events", () => {
    const terminals: [string, DeliveryWorkflow][] = [
      ["done", done()],
      ["stopped", stopped()],
      ["terminated", terminated()],
    ];
    const events: LoopEvent[] = [
      "plan_completed",
      "implementation_completed",
      "redispatch_requested",
      "gate_passed",
      "gate_blocked",
      "pr_linked",
      "babysit_passed",
      "babysit_blocked",
      "blocked_resume",
      "manual_stop",
      "mark_done",
      "exhausted_retries",
      "pr_closed",
      "pr_merged",
    ];

    for (const [name, wf] of terminals) {
      for (const event of events) {
        it(`${name} + ${event} → null`, () => {
          expect(reduce(wf, event)).toBeNull();
        });
      }
    }
  });

  // -----------------------------------------------------------------------
  // Universal events from all active states
  // -----------------------------------------------------------------------
  describe("universal events from active states", () => {
    const activeStates: [string, DeliveryWorkflow][] = [
      ["planning", planning()],
      ["implementing", implementing()],
      ["gating(review)", gating(reviewGate())],
      ["gating(ci)", gating(ciGate())],
      ["gating(ui)", gating(uiGate())],
      ["awaiting_pr", awaitingPr()],
      ["babysitting", babysitting()],
      ["awaiting_plan_approval", awaitingPlanApproval()],
      ["awaiting_manual_fix", awaitingManualFix()],
      ["awaiting_operator_action", awaitingOperatorAction()],
    ];

    describe("manual_stop → stopped", () => {
      for (const [name, wf] of activeStates) {
        it(`${name}`, () => {
          const result = reduce(wf, "manual_stop");
          expect(result).not.toBeNull();
          expect(result!.kind).toBe("stopped");
          if (result!.kind === "stopped") {
            expect(result!.reason).toEqual({ kind: "user_requested" });
          }
          expect(result!.version).toBe(wf.version + 1);
        });
      }
    });

    describe("pr_closed → terminated", () => {
      for (const [name, wf] of activeStates) {
        it(`${name}`, () => {
          const result = reduce(wf, "pr_closed");
          expect(result).not.toBeNull();
          expect(result!.kind).toBe("terminated");
          if (result!.kind === "terminated") {
            expect(result!.reason).toEqual({ kind: "pr_closed" });
          }
        });
      }
    });

    describe("pr_merged → terminated", () => {
      for (const [name, wf] of activeStates) {
        it(`${name}`, () => {
          const result = reduce(wf, "pr_merged");
          expect(result).not.toBeNull();
          expect(result!.kind).toBe("terminated");
          if (result!.kind === "terminated") {
            expect(result!.reason).toEqual({ kind: "pr_merged" });
          }
        });
      }
    });

    describe("exhausted_retries → awaiting_manual_fix", () => {
      for (const [name, wf] of activeStates) {
        it(`${name}`, () => {
          const result = reduce(wf, "exhausted_retries");
          expect(result).not.toBeNull();
          expect(result!.kind).toBe("awaiting_manual_fix");
          if (result!.kind === "awaiting_manual_fix") {
            expect(result!.reason.description).toBe("Retry budget exhausted");
            expect(result!.resumableFrom).toBeDefined();
          }
        });
      }
    });
  });

  // -----------------------------------------------------------------------
  // Planning
  // -----------------------------------------------------------------------
  describe("planning", () => {
    it("plan_completed → implementing (dispatch queued, fix attempts reset)", () => {
      const wf = planning({ fixAttemptCount: 3 });
      const result = reduce(wf, "plan_completed");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("implementing");
      if (result!.kind === "implementing") {
        expect(result!.dispatch.kind).toBe("queued");
        expect(result!.fixAttemptCount).toBe(0);
        expect(result!.planVersion).toBe(1);
      }
    });

    it("implementation_completed → null", () => {
      expect(reduce(planning(), "implementation_completed")).toBeNull();
    });

    it("gate_passed → null", () => {
      expect(reduce(planning(), "gate_passed")).toBeNull();
    });

    it("run_completed is not a valid event", () => {
      // run_completed doesn't exist in the LoopEvent union, so this is implicitly tested
    });

    it("babysit_passed → null", () => {
      expect(reduce(planning(), "babysit_passed")).toBeNull();
    });

    it("gate_blocked → stays in planning (version bump for re-dispatch)", () => {
      const wf = planning();
      const result = reduce(wf, "gate_blocked");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("planning");
      expect(result!.version).toBe(wf.version + 1);
    });
  });

  // -----------------------------------------------------------------------
  // Implementing
  // -----------------------------------------------------------------------
  describe("implementing", () => {
    it("implementation_completed → gating(review)", () => {
      const result = reduce(implementing(), "implementation_completed", {
        headSha: "sha-abc",
      });
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("gating");
      if (result!.kind === "gating") {
        expect(result!.gate.kind).toBe("review");
        expect(result!.headSha).toBe("sha-abc");
      }
    });

    it("implementation_completed resets fixAttemptCount", () => {
      const wf = implementing({ fixAttemptCount: 3 });
      const result = reduce(wf, "implementation_completed");
      expect(result!.fixAttemptCount).toBe(0);
    });

    it("redispatch_requested → implementing (no fixAttemptCount increment)", () => {
      const wf = implementing({ fixAttemptCount: 2 });
      const result = reduce(wf, "redispatch_requested");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("implementing");
      expect(result!.fixAttemptCount).toBe(2); // NOT incremented
      expect(result!.infraRetryCount).toBe(0); // NOT incremented without infraRetry context
      if (result!.kind === "implementing") {
        expect(result!.dispatch.kind).toBe("queued");
      }
    });

    it("redispatch_requested + infraRetry → implementing (infraRetryCount incremented, fixAttemptCount unchanged)", () => {
      const wf = implementing({ fixAttemptCount: 2, infraRetryCount: 3 });
      const result = reduce(wf, "redispatch_requested", { infraRetry: true });
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("implementing");
      expect(result!.fixAttemptCount).toBe(2); // NOT incremented
      expect(result!.infraRetryCount).toBe(4); // incremented
    });

    it("gate_blocked → implementing (fixAttemptCount incremented)", () => {
      const wf = implementing({ fixAttemptCount: 1 });
      const result = reduce(wf, "gate_blocked");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("implementing");
      expect(result!.fixAttemptCount).toBe(2);
    });

    it("gate_blocked + infraRetry → implementing (infraRetryCount incremented, fixAttemptCount unchanged)", () => {
      const wf = implementing({ fixAttemptCount: 2, infraRetryCount: 4 });
      const result = reduce(wf, "gate_blocked", { infraRetry: true });
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("implementing");
      expect(result!.fixAttemptCount).toBe(2);
      expect(result!.infraRetryCount).toBe(5);
    });

    it("plan_completed → null", () => {
      expect(reduce(implementing(), "plan_completed")).toBeNull();
    });

    it("babysit_passed → null", () => {
      expect(reduce(implementing(), "babysit_passed")).toBeNull();
    });

    it("pr_linked → null", () => {
      expect(reduce(implementing(), "pr_linked")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Gating
  // -----------------------------------------------------------------------
  describe("gating", () => {
    it("review + gate_passed → gating(ci)", () => {
      const result = reduce(gating(reviewGate()), "gate_passed");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("gating");
      if (result!.kind === "gating") {
        expect(result!.gate.kind).toBe("ci");
      }
    });

    it("ci + gate_passed → gating(ui)", () => {
      const result = reduce(gating(ciGate()), "gate_passed");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("gating");
      if (result!.kind === "gating") {
        expect(result!.gate.kind).toBe("ui");
      }
    });

    it("ui + gate_passed + hasPrLink → babysitting", () => {
      const result = reduce(gating(uiGate()), "gate_passed", {
        hasPrLink: true,
        prNumber: 99,
      });
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("babysitting");
      if (result!.kind === "babysitting") {
        expect(result!.reviewSurface).toEqual({
          kind: "github_pr",
          prNumber: 99,
        });
        expect(result!.nextCheckAt).toEqual(
          new Date(NOW.getTime() + 5 * 60_000),
        );
      }
    });

    it("ui + gate_passed + no PR → awaiting_pr", () => {
      const result = reduce(gating(uiGate()), "gate_passed", {
        hasPrLink: false,
      });
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("awaiting_pr");
    });

    it("gate_passed resets fixAttemptCount", () => {
      const wf = gating(reviewGate(), { fixAttemptCount: 4 });
      const result = reduce(wf, "gate_passed");
      expect(result!.fixAttemptCount).toBe(0);
    });

    it("gate_blocked → implementing (fixAttemptCount++)", () => {
      const wf = gating(reviewGate(), { fixAttemptCount: 2 });
      const result = reduce(wf, "gate_blocked");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("implementing");
      expect(result!.fixAttemptCount).toBe(3);
    });

    it("gate_blocked + infraRetry → implementing (infraRetryCount incremented, fixAttemptCount unchanged)", () => {
      const wf = gating(reviewGate(), {
        fixAttemptCount: 2,
        infraRetryCount: 1,
      });
      const result = reduce(wf, "gate_blocked", { infraRetry: true });
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("implementing");
      expect(result!.fixAttemptCount).toBe(2);
      expect(result!.infraRetryCount).toBe(2);
    });

    it("implementation_completed → null", () => {
      expect(
        reduce(gating(reviewGate()), "implementation_completed"),
      ).toBeNull();
    });

    it("plan_completed → null", () => {
      expect(reduce(gating(reviewGate()), "plan_completed")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Babysitting
  // -----------------------------------------------------------------------
  describe("babysitting", () => {
    it("babysit_passed → done(completed)", () => {
      const result = reduce(babysitting(), "babysit_passed");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("done");
      if (result!.kind === "done") {
        expect(result!.outcome).toBe("completed");
        expect(result!.completedAt).toEqual(NOW);
      }
    });

    it("babysit_blocked → implementing (retry)", () => {
      const wf = babysitting({ fixAttemptCount: 1 });
      const result = reduce(wf, "babysit_blocked");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("implementing");
      expect(result!.fixAttemptCount).toBe(2);
    });

    it("mark_done → done", () => {
      const result = reduce(babysitting(), "mark_done");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("done");
      if (result!.kind === "done") {
        expect(result!.outcome).toBe("completed");
      }
    });

    it("gate_passed → null", () => {
      expect(reduce(babysitting(), "gate_passed")).toBeNull();
    });

    it("plan_completed → null", () => {
      expect(reduce(babysitting(), "plan_completed")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Awaiting states
  // -----------------------------------------------------------------------
  describe("awaiting_pr", () => {
    it("pr_linked → babysitting", () => {
      const result = reduce(awaitingPr(), "pr_linked", { prNumber: 55 });
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("babysitting");
      if (result!.kind === "babysitting") {
        expect(result!.reviewSurface).toEqual({
          kind: "github_pr",
          prNumber: 55,
        });
      }
    });

    it("pr_linked resets fixAttemptCount", () => {
      const wf = awaitingPr({ fixAttemptCount: 3 });
      const result = reduce(wf, "pr_linked");
      expect(result!.fixAttemptCount).toBe(0);
    });

    it("mark_done → done", () => {
      const result = reduce(awaitingPr(), "mark_done");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("done");
    });

    it("gate_passed → null", () => {
      expect(reduce(awaitingPr(), "gate_passed")).toBeNull();
    });
  });

  describe("awaiting_plan_approval", () => {
    it("plan_completed → implementing", () => {
      const wf = awaitingPlanApproval({ fixAttemptCount: 2 });
      const result = reduce(wf, "plan_completed");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("implementing");
      expect(result!.fixAttemptCount).toBe(0); // reset
      if (result!.kind === "implementing") {
        expect(result!.dispatch.kind).toBe("queued");
      }
    });

    it("blocked_resume → planning", () => {
      const result = reduce(awaitingPlanApproval(), "blocked_resume");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("planning");
      if (result!.kind === "planning") {
        expect(result!.planVersion).toBe(1);
      }
    });

    it("gate_passed → null", () => {
      expect(reduce(awaitingPlanApproval(), "gate_passed")).toBeNull();
    });
  });

  describe("awaiting_manual_fix", () => {
    it("blocked_resume → resumes from resumableFrom (implementing)", () => {
      const wf = awaitingManualFix({
        kind: "implementing",
        dispatchId: "d-resume" as DispatchId,
        planVersion: 2 as PlanVersion,
      });
      const result = reduce(wf, "blocked_resume");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("implementing");
      if (result!.kind === "implementing") {
        expect(result!.dispatch.kind).toBe("queued");
        expect(result!.dispatch.dispatchId).toBe("d-resume");
      }
    });

    it("blocked_resume → resumes from resumableFrom (gating)", () => {
      const wf = awaitingManualFix({
        kind: "gating",
        gate: "ci",
        headSha: "sha-fix" as GitSha,
      });
      const result = reduce(wf, "blocked_resume");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("gating");
      if (result!.kind === "gating") {
        expect(result!.gate.kind).toBe("ci");
      }
    });

    it("blocked_resume → resumes from resumableFrom (awaiting_pr)", () => {
      const wf = awaitingManualFix({
        kind: "awaiting_pr",
        headSha: "sha-pr" as GitSha,
      });
      const result = reduce(wf, "blocked_resume");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("awaiting_pr");
    });

    it("blocked_resume with babysitting target → null (cannot resume to babysitting)", () => {
      const wf = awaitingManualFix({
        kind: "babysitting",
        headSha: "sha-bs" as GitSha,
      });
      const result = reduce(wf, "blocked_resume");
      expect(result).toBeNull();
    });

    it("blocked_resume with context resumeTo overrides resumableFrom", () => {
      const wf = awaitingManualFix({
        kind: "implementing",
        dispatchId: "d-old" as DispatchId,
        planVersion: 1 as PlanVersion,
      });
      const result = reduce(wf, "blocked_resume", {
        resumeTo: {
          kind: "gating",
          gate: "review",
          headSha: "sha-ctx" as GitSha,
        },
      });
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("gating");
    });

    it("gate_passed → null", () => {
      expect(reduce(awaitingManualFix(), "gate_passed")).toBeNull();
    });

    it("plan_completed → null", () => {
      expect(reduce(awaitingManualFix(), "plan_completed")).toBeNull();
    });
  });

  describe("awaiting_operator_action", () => {
    it("blocked_resume → resumes from resumableFrom", () => {
      const wf = awaitingOperatorAction({
        kind: "implementing",
        dispatchId: "d-op" as DispatchId,
        planVersion: 1 as PlanVersion,
      });
      const result = reduce(wf, "blocked_resume");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("implementing");
    });

    it("blocked_resume with planning resumableFrom → planning", () => {
      const wf = awaitingOperatorAction({
        kind: "planning",
        planVersion: 2 as PlanVersion,
      });
      const result = reduce(wf, "blocked_resume");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("planning");
      if (result!.kind === "planning") {
        expect(result!.planVersion).toBe(2);
      }
    });

    it("gate_passed → null", () => {
      expect(reduce(awaitingOperatorAction(), "gate_passed")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Fix budget
  // -----------------------------------------------------------------------
  describe("fix budget", () => {
    it("gate_blocked at max retries still transitions (exhausted_retries is a separate event)", () => {
      const wf = implementing({ fixAttemptCount: 5, maxFixAttempts: 6 });
      const result = reduce(wf, "gate_blocked");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("implementing");
      expect(result!.fixAttemptCount).toBe(6);
    });

    it("gate_blocked below max stays in implementing", () => {
      const wf = gating(reviewGate(), {
        fixAttemptCount: 1,
        maxFixAttempts: 6,
      });
      const result = reduce(wf, "gate_blocked");
      expect(result!.kind).toBe("implementing");
      expect(result!.fixAttemptCount).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Version bumping
  // -----------------------------------------------------------------------
  describe("version bumping", () => {
    it("increments version on transition", () => {
      const wf = planning({ version: 5 });
      const result = reduce(wf, "plan_completed");
      expect(result!.version).toBe(6);
    });

    it("sets updatedAt and lastActivityAt to now", () => {
      const result = reduce(planning(), "plan_completed");
      expect(result!.updatedAt).toEqual(NOW);
      expect(result!.lastActivityAt).toEqual(NOW);
    });
  });
});

// ---------------------------------------------------------------------------
// shouldResetFixAttemptCount
// ---------------------------------------------------------------------------

describe("shouldResetFixAttemptCount", () => {
  const resetEvents: LoopEvent[] = [
    "plan_completed",
    "implementation_completed",
    "gate_passed",
    "pr_linked",
    "babysit_passed",
  ];

  const noResetEvents: LoopEvent[] = [
    "gate_blocked",
    "manual_stop",
    "redispatch_requested",
    "babysit_blocked",
    "blocked_resume",
    "mark_done",
    "exhausted_retries",
    "pr_closed",
    "pr_merged",
  ];

  for (const event of resetEvents) {
    it(`returns true for ${event}`, () => {
      expect(shouldResetFixAttemptCount(event, {})).toBe(true);
    });
  }

  for (const event of noResetEvents) {
    it(`returns false for ${event}`, () => {
      expect(shouldResetFixAttemptCount(event, {})).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// derivePendingAction
// ---------------------------------------------------------------------------

describe("derivePendingAction", () => {
  it("implementing (queued dispatch) → null", () => {
    expect(derivePendingAction(implementing())).toBeNull();
  });

  it("implementing (sent dispatch) → dispatch_ack", () => {
    const deadline = new Date("2026-01-01T00:10:00Z");
    const wf = implementing({
      dispatch: {
        kind: "sent",
        dispatchId: "d-2" as DispatchId,
        executionClass: "implementation_runtime",
        sentAt: NOW,
        ackDeadlineAt: deadline,
        dispatchMechanism: "self_dispatch",
      },
    });
    const action = derivePendingAction(wf);
    expect(action).toEqual({
      kind: "dispatch_ack",
      dispatchId: "d-2",
      deadlineAt: deadline,
    });
  });

  it("gating(review) → gate_result(review)", () => {
    expect(derivePendingAction(gating(reviewGate()))).toEqual({
      kind: "gate_result",
      gate: "review",
    });
  });

  it("gating(ci) → gate_result(ci)", () => {
    expect(derivePendingAction(gating(ciGate()))).toEqual({
      kind: "gate_result",
      gate: "ci",
    });
  });

  it("gating(ui) → gate_result(ui)", () => {
    expect(derivePendingAction(gating(uiGate()))).toEqual({
      kind: "gate_result",
      gate: "ui",
    });
  });

  it("awaiting_plan_approval → human_input(plan_approval)", () => {
    const action = derivePendingAction(awaitingPlanApproval());
    expect(action).toEqual({
      kind: "human_input",
      reason: { kind: "plan_approval", planVersion: 1 },
    });
  });

  it("awaiting_manual_fix → human_input(manual_fix)", () => {
    const action = derivePendingAction(awaitingManualFix());
    expect(action).toEqual({
      kind: "human_input",
      reason: {
        kind: "manual_fix",
        issue: {
          description: "Retry budget exhausted",
          suggestedAction: "Fix it",
        },
      },
    });
  });

  it("awaiting_operator_action → human_input(operator_action)", () => {
    const action = derivePendingAction(awaitingOperatorAction());
    expect(action).toEqual({
      kind: "human_input",
      reason: {
        kind: "operator_action",
        reason: { description: "System failure", system: "daemon" },
        incidentId: "inc-1",
      },
    });
  });

  it("awaiting_pr → review_surface_link", () => {
    expect(derivePendingAction(awaitingPr())).toEqual({
      kind: "review_surface_link",
    });
  });

  it("awaiting_pr → awaiting_operator_action after operator action signal", () => {
    const wf = awaitingPr();
    const next = reduceWorkflow({
      snapshot: wf,
      event: "operator_action_required",
      context: {
        reason: "PR creation or linkage requires operator action",
        incidentId: "inc-1",
      },
      now: NOW,
    });

    expect(next).toMatchObject({
      kind: "awaiting_operator_action",
      incidentId: "inc-1",
      reason: {
        description: "PR creation or linkage requires operator action",
        system: "github",
      },
    });
  });

  it("babysitting → babysit_recheck", () => {
    const wf = babysitting();
    const action = derivePendingAction(wf);
    expect(action).toEqual({
      kind: "babysit_recheck",
      nextCheckAt: wf.nextCheckAt,
    });
  });

  it("planning → null", () => {
    expect(derivePendingAction(planning())).toBeNull();
  });

  it("done → null", () => {
    expect(derivePendingAction(done())).toBeNull();
  });

  it("stopped → null", () => {
    expect(derivePendingAction(stopped())).toBeNull();
  });

  it("terminated → null", () => {
    expect(derivePendingAction(terminated())).toBeNull();
  });
});
