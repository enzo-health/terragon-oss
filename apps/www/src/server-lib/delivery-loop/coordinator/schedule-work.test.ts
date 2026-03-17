import { describe, it, expect } from "vitest";
import { resolveWorkItems, type ScheduledWorkItem } from "./schedule-work";
import type {
  DeliveryWorkflow,
  WorkflowId,
  ThreadId,
  PlanVersion,
  GitSha,
  DispatchId,
  GateSubState,
} from "@terragon/shared/delivery-loop/domain/workflow";
import type { LoopEvent } from "@terragon/shared/delivery-loop/domain/events";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const NOW = new Date("2026-03-17T00:00:00Z");

const COMMON = {
  workflowId: "wf-1" as WorkflowId,
  threadId: "t-1" as ThreadId,
  generation: 1,
  version: 1,
  fixAttemptCount: 0,
  maxFixAttempts: 3,
  createdAt: NOW,
  updatedAt: NOW,
  lastActivityAt: null,
} as const;

function planning(overrides?: Partial<DeliveryWorkflow>): DeliveryWorkflow {
  return {
    ...COMMON,
    kind: "planning",
    planVersion: null,
    ...overrides,
  } as DeliveryWorkflow;
}

function implementing(overrides?: Partial<DeliveryWorkflow>): DeliveryWorkflow {
  return {
    ...COMMON,
    kind: "implementing",
    planVersion: 1 as PlanVersion,
    dispatch: {
      kind: "queued",
      dispatchId: "d-1" as DispatchId,
      executionClass: "implementation_runtime",
    },
    ...overrides,
  } as DeliveryWorkflow;
}

function gating(
  gate: GateSubState,
  overrides?: Partial<DeliveryWorkflow>,
): DeliveryWorkflow {
  return {
    ...COMMON,
    kind: "gating",
    headSha: "abc123" as GitSha,
    gate,
    ...overrides,
  } as DeliveryWorkflow;
}

function babysitting(overrides?: Partial<DeliveryWorkflow>): DeliveryWorkflow {
  const nextCheckAt = new Date("2026-03-17T00:05:00Z");
  return {
    ...COMMON,
    kind: "babysitting",
    headSha: "abc123" as GitSha,
    reviewSurface: { kind: "github_pr", prNumber: 42 },
    nextCheckAt,
    ...overrides,
  } as DeliveryWorkflow;
}

function done(overrides?: Partial<DeliveryWorkflow>): DeliveryWorkflow {
  return {
    ...COMMON,
    kind: "done",
    outcome: "completed",
    completedAt: NOW,
    ...overrides,
  } as DeliveryWorkflow;
}

function stopped(overrides?: Partial<DeliveryWorkflow>): DeliveryWorkflow {
  return {
    ...COMMON,
    kind: "stopped",
    reason: { kind: "user_requested" },
    ...overrides,
  } as DeliveryWorkflow;
}

function terminated(overrides?: Partial<DeliveryWorkflow>): DeliveryWorkflow {
  return {
    ...COMMON,
    kind: "terminated",
    reason: { kind: "pr_closed" },
    ...overrides,
  } as DeliveryWorkflow;
}

function awaitingPlanApproval(
  overrides?: Partial<DeliveryWorkflow>,
): DeliveryWorkflow {
  return {
    ...COMMON,
    kind: "awaiting_plan_approval",
    planVersion: 1 as PlanVersion,
    resumableFrom: { kind: "planning", planVersion: 1 as PlanVersion },
    ...overrides,
  } as DeliveryWorkflow;
}

function awaitingManualFix(
  overrides?: Partial<DeliveryWorkflow>,
): DeliveryWorkflow {
  return {
    ...COMMON,
    kind: "awaiting_manual_fix",
    reason: { description: "test", suggestedAction: null },
    resumableFrom: {
      kind: "implementing",
      dispatchId: "d-1" as DispatchId,
      planVersion: 1 as PlanVersion,
    },
    ...overrides,
  } as DeliveryWorkflow;
}

const REVIEW_GATE: GateSubState = {
  kind: "review",
  status: "waiting",
  runId: null,
  snapshot: { requiredApprovals: 1, approvalsReceived: 0, blockers: [] },
};

const CI_GATE: GateSubState = {
  kind: "ci",
  status: "waiting",
  runId: null,
  snapshot: { checkSuites: [], failingRequiredChecks: [] },
};

const UI_GATE: GateSubState = {
  kind: "ui",
  status: "waiting",
  runId: null,
  snapshot: { artifactUrl: null, blockers: [] },
};

function byKind(items: ScheduledWorkItem[], kind: ScheduledWorkItem["kind"]) {
  return items.filter((i) => i.kind === kind);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveWorkItems", () => {
  // -----------------------------------------------------------------------
  // Publication scheduling
  // -----------------------------------------------------------------------
  describe("publication scheduling", () => {
    it("emits 2 publication items when state kind changes (implementing -> gating)", () => {
      const items = resolveWorkItems({
        previousWorkflow: implementing(),
        newWorkflow: gating(REVIEW_GATE),
        event: "gate_passed",
        now: NOW,
      });

      const pubs = byKind(items, "publication");
      expect(pubs).toHaveLength(2);
      expect(pubs[0]!.payloadJson.target).toEqual({ kind: "status_comment" });
      expect(pubs[1]!.payloadJson.target).toEqual({
        kind: "check_run_summary",
      });
      expect(pubs[0]!.payloadJson.workflowState).toBe("gating");
      expect(pubs[0]!.payloadJson.gate).toBe("review");
    });

    it("emits 2 publication items when gate sub-state changes within gating (review -> ci)", () => {
      const items = resolveWorkItems({
        previousWorkflow: gating(REVIEW_GATE),
        newWorkflow: gating(CI_GATE),
        event: "gate_passed",
        now: NOW,
      });

      const pubs = byKind(items, "publication");
      expect(pubs).toHaveLength(2);
      expect(pubs[0]!.payloadJson.gate).toBe("ci");
    });

    it("emits no publication items when same state and same version", () => {
      const wf = implementing();
      const items = resolveWorkItems({
        previousWorkflow: wf,
        newWorkflow: wf,
        event: "redispatch_requested",
        now: NOW,
      });

      const pubs = byKind(items, "publication");
      expect(pubs).toHaveLength(0);
    });

    it("emits publication items on terminal state transition", () => {
      const items = resolveWorkItems({
        previousWorkflow: implementing(),
        newWorkflow: done(),
        event: "mark_done",
        now: NOW,
      });

      const pubs = byKind(items, "publication");
      expect(pubs).toHaveLength(2);
      expect(pubs[0]!.payloadJson.workflowState).toBe("done");
    });
  });

  // -----------------------------------------------------------------------
  // Dispatch scheduling
  // -----------------------------------------------------------------------
  describe("dispatch scheduling", () => {
    it("schedules dispatch with implementation_runtime when entering implementing from planning", () => {
      const items = resolveWorkItems({
        previousWorkflow: planning(),
        newWorkflow: implementing(),
        event: "implementation_completed",
        now: NOW,
      });

      const dispatches = byKind(items, "dispatch");
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]!.payloadJson.executionClass).toBe(
        "implementation_runtime",
      );
      expect(dispatches[0]!.payloadJson.workflowId).toBe("wf-1");
    });

    it("schedules dispatch when staying in implementing with version bump (redispatch)", () => {
      const items = resolveWorkItems({
        previousWorkflow: implementing({ version: 1 }),
        newWorkflow: implementing({ version: 2 }),
        event: "redispatch_requested",
        now: NOW,
      });

      const dispatches = byKind(items, "dispatch");
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]!.payloadJson.executionClass).toBe(
        "implementation_runtime",
      );
    });

    it("does not schedule dispatch when staying in implementing with same version", () => {
      const wf = implementing({ version: 3 });
      const items = resolveWorkItems({
        previousWorkflow: wf,
        newWorkflow: wf,
        event: "redispatch_requested",
        now: NOW,
      });

      const dispatches = byKind(items, "dispatch");
      expect(dispatches).toHaveLength(0);
    });

    it("schedules dispatch with gate_runtime when entering gating with review gate", () => {
      const items = resolveWorkItems({
        previousWorkflow: implementing(),
        newWorkflow: gating(REVIEW_GATE),
        event: "gate_passed",
        now: NOW,
      });

      const dispatches = byKind(items, "dispatch");
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]!.payloadJson.executionClass).toBe("gate_runtime");
      expect(dispatches[0]!.payloadJson.gate).toBe("review");
    });

    it("does NOT schedule dispatch when entering gating with ci gate", () => {
      const items = resolveWorkItems({
        previousWorkflow: implementing(),
        newWorkflow: gating(CI_GATE),
        event: "gate_passed",
        now: NOW,
      });

      const dispatches = byKind(items, "dispatch");
      expect(dispatches).toHaveLength(0);
    });

    it("schedules dispatch with gate_runtime when entering gating with ui gate", () => {
      const items = resolveWorkItems({
        previousWorkflow: implementing(),
        newWorkflow: gating(UI_GATE),
        event: "gate_passed",
        now: NOW,
      });

      const dispatches = byKind(items, "dispatch");
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]!.payloadJson.executionClass).toBe("gate_runtime");
      expect(dispatches[0]!.payloadJson.gate).toBe("ui");
    });

    it("schedules dispatch when entering planning from a different state", () => {
      const items = resolveWorkItems({
        previousWorkflow: awaitingPlanApproval(),
        newWorkflow: planning(),
        event: "blocked_resume",
        now: NOW,
      });

      const dispatches = byKind(items, "dispatch");
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]!.payloadJson.executionClass).toBe(
        "implementation_runtime",
      );
    });
  });

  // -----------------------------------------------------------------------
  // Babysit scheduling
  // -----------------------------------------------------------------------
  describe("babysit scheduling", () => {
    it("schedules babysit item at nextCheckAt when entering babysitting", () => {
      const nextCheckAt = new Date("2026-03-17T00:05:00Z");
      const items = resolveWorkItems({
        previousWorkflow: gating(REVIEW_GATE),
        newWorkflow: babysitting({ nextCheckAt }),
        event: "babysit_passed",
        now: NOW,
      });

      const babysits = byKind(items, "babysit");
      expect(babysits).toHaveLength(1);
      expect(babysits[0]!.scheduledAt).toEqual(nextCheckAt);
      expect(babysits[0]!.payloadJson.workflowId).toBe("wf-1");
    });

    it("schedules babysit item when staying in babysitting", () => {
      const nextCheckAt1 = new Date("2026-03-17T00:05:00Z");
      const nextCheckAt2 = new Date("2026-03-17T00:10:00Z");
      const items = resolveWorkItems({
        previousWorkflow: babysitting({ nextCheckAt: nextCheckAt1 }),
        newWorkflow: babysitting({ nextCheckAt: nextCheckAt2 }),
        event: "babysit_passed",
        now: NOW,
      });

      const babysits = byKind(items, "babysit");
      expect(babysits).toHaveLength(1);
      expect(babysits[0]!.scheduledAt).toEqual(nextCheckAt2);
    });
  });

  // -----------------------------------------------------------------------
  // No-work states
  // -----------------------------------------------------------------------
  describe("no-work states", () => {
    it("produces no dispatch/babysit items when entering awaiting_plan_approval", () => {
      const items = resolveWorkItems({
        previousWorkflow: planning(),
        newWorkflow: awaitingPlanApproval(),
        event: "plan_completed",
        now: NOW,
      });

      const dispatches = byKind(items, "dispatch");
      const babysits = byKind(items, "babysit");
      expect(dispatches).toHaveLength(0);
      expect(babysits).toHaveLength(0);
    });

    it("produces no dispatch/babysit items when entering awaiting_manual_fix", () => {
      const items = resolveWorkItems({
        previousWorkflow: implementing(),
        newWorkflow: awaitingManualFix(),
        event: "gate_blocked",
        now: NOW,
      });

      const dispatches = byKind(items, "dispatch");
      const babysits = byKind(items, "babysit");
      expect(dispatches).toHaveLength(0);
      expect(babysits).toHaveLength(0);
    });

    it("produces no dispatch/babysit items when entering done", () => {
      const items = resolveWorkItems({
        previousWorkflow: implementing(),
        newWorkflow: done(),
        event: "mark_done",
        now: NOW,
      });

      const dispatches = byKind(items, "dispatch");
      const babysits = byKind(items, "babysit");
      expect(dispatches).toHaveLength(0);
      expect(babysits).toHaveLength(0);
    });

    it("produces no dispatch/babysit items when entering stopped", () => {
      const items = resolveWorkItems({
        previousWorkflow: implementing(),
        newWorkflow: stopped(),
        event: "manual_stop",
        now: NOW,
      });

      const dispatches = byKind(items, "dispatch");
      const babysits = byKind(items, "babysit");
      expect(dispatches).toHaveLength(0);
      expect(babysits).toHaveLength(0);
    });

    it("produces no dispatch/babysit items when entering terminated", () => {
      const items = resolveWorkItems({
        previousWorkflow: implementing(),
        newWorkflow: terminated(),
        event: "pr_closed",
        now: NOW,
      });

      const dispatches = byKind(items, "dispatch");
      const babysits = byKind(items, "babysit");
      expect(dispatches).toHaveLength(0);
      expect(babysits).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // loopId passthrough
  // -----------------------------------------------------------------------
  describe("loopId passthrough", () => {
    it("includes loopId in publication payloads when provided", () => {
      const items = resolveWorkItems({
        previousWorkflow: implementing(),
        newWorkflow: gating(REVIEW_GATE),
        event: "gate_passed",
        loopId: "loop-42",
        now: NOW,
      });

      const pubs = byKind(items, "publication");
      expect(pubs[0]!.payloadJson.loopId).toBe("loop-42");
    });

    it("omits loopId from publication payloads when not provided", () => {
      const items = resolveWorkItems({
        previousWorkflow: implementing(),
        newWorkflow: gating(REVIEW_GATE),
        event: "gate_passed",
        now: NOW,
      });

      const pubs = byKind(items, "publication");
      expect(pubs[0]!.payloadJson.loopId).toBeUndefined();
    });
  });
});
