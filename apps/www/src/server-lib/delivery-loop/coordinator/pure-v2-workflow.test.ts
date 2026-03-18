import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import {
  createWorkflow,
  getWorkflow,
} from "@terragon/shared/delivery-loop/store/workflow-store";
import { appendSignalToInbox } from "@terragon/shared/delivery-loop/store/signal-inbox-store";
import { getWorkflowEvents } from "@terragon/shared/delivery-loop/store/event-store";
import { nanoid } from "nanoid/non-secure";
import { runCoordinatorTick } from "./tick";
import type {
  WorkflowId,
  CorrelationId,
} from "@terragon/shared/delivery-loop/domain/workflow";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testUserId: string;
let testThreadId: string;

beforeEach(async () => {
  const { user } = await createTestUser({ db });
  const { threadId } = await createTestThread({ db, userId: user.id });
  testUserId = user.id;
  testThreadId = threadId;
});

async function createPureV2Workflow(params: {
  kind: string;
  stateJson?: Record<string, unknown>;
  maxFixAttempts?: number;
}) {
  return createWorkflow({
    db,
    threadId: testThreadId,
    generation: Math.floor(Math.random() * 1_000_000),
    kind: params.kind,
    stateJson: params.stateJson ?? {},
    maxFixAttempts: params.maxFixAttempts,
    userId: testUserId,
  });
}

function correlationId(): CorrelationId {
  return nanoid() as CorrelationId;
}

async function injectSignal(
  workflowId: string,
  causeType: import("@terragon/shared/db/types").SdlcLoopCauseType,
  payload: Record<string, unknown>,
) {
  return appendSignalToInbox({
    db,
    loopId: workflowId,
    causeType,
    payload,
  });
}

// -- Signal builders --

function daemonRunCompleted(workflowId: string) {
  return injectSignal(workflowId, "daemon_run_completed", {
    source: "daemon",
    event: {
      kind: "run_completed",
      runId: `run-${nanoid(6)}`,
      result: { kind: "success", headSha: "abc123", summary: "done" },
    },
  });
}

function daemonRunFailed(workflowId: string) {
  return injectSignal(workflowId, "daemon_run_failed", {
    source: "daemon",
    event: {
      kind: "run_failed",
      runId: `run-${nanoid(6)}`,
      failure: { kind: "runtime_crash", exitCode: 1, message: "crash" },
    },
  });
}

function reviewPassed(workflowId: string) {
  return injectSignal(workflowId, "github_review_changed", {
    source: "github",
    event: {
      kind: "review_changed",
      prNumber: 1,
      result: {
        passed: true,
        unresolvedThreadCount: 0,
        approvalCount: 1,
        requiredApprovals: 1,
      },
    },
  });
}

function ciPassed(workflowId: string) {
  return injectSignal(workflowId, "github_ci_changed", {
    source: "github",
    event: {
      kind: "ci_changed",
      prNumber: 1,
      result: { passed: true, requiredChecks: ["build"], failingChecks: [] },
    },
  });
}

function humanStop(workflowId: string) {
  return injectSignal(workflowId, "human_stop", {
    source: "human",
    event: { kind: "stop_requested", actorUserId: "test-user" },
  });
}

async function tick(workflowId: string) {
  return runCoordinatorTick({
    db,
    workflowId: workflowId as WorkflowId,
    correlationId: correlationId(),
  });
}

// -- Reusable state builders --

const PLANNING_STATE = {};

const IMPLEMENTING_STATE = {
  planVersion: 1,
  dispatch: {
    kind: "queued",
    dispatchId: "d-test",
    executionClass: "implementation_runtime",
  },
};

function gatingState(gate: "review" | "ci" | "ui") {
  const snapshots: Record<string, unknown> = {
    review: {
      kind: "review",
      status: "waiting",
      runId: null,
      snapshot: { requiredApprovals: 1, approvalsReceived: 0, blockers: [] },
    },
    ci: {
      kind: "ci",
      status: "waiting",
      runId: null,
      snapshot: { checkSuites: [], failingRequiredChecks: [] },
    },
    ui: {
      kind: "ui",
      status: "waiting",
      runId: null,
      snapshot: { artifactUrl: null, blockers: [] },
    },
  };
  return { headSha: "sha-test", gate: snapshots[gate] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pure v2 workflow integration (no v1 sdlcLoop)", () => {
  describe("planning phase", () => {
    it("transitions planning -> implementing via plan_approved signal", async () => {
      const wf = await createPureV2Workflow({
        kind: "awaiting_plan_approval",
        stateJson: {
          planVersion: 1,
          resumableFrom: { kind: "planning", planVersion: 1 },
        },
      });

      await injectSignal(wf.id, "human_resume", {
        source: "human",
        event: { kind: "plan_approved", artifactId: "plan-1" },
      });
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateBefore).toBe("awaiting_plan_approval");
      expect(result.stateAfter).toBe("implementing");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("implementing");
    });

    it("planning advances to implementing on run_completed", async () => {
      const wf = await createPureV2Workflow({
        kind: "planning",
        stateJson: PLANNING_STATE,
      });

      await daemonRunCompleted(wf.id);
      const result = await tick(wf.id);

      // run_completed in planning produces plan_completed → implementing
      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("implementing");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("implementing");
    });

    it("planning -> stopped via human stop", async () => {
      const wf = await createPureV2Workflow({
        kind: "planning",
        stateJson: PLANNING_STATE,
      });

      await humanStop(wf.id);
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("stopped");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("stopped");
    });
  });

  describe("implementing phase", () => {
    it("transitions implementing -> gating(review) via run_completed", async () => {
      const wf = await createPureV2Workflow({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      await daemonRunCompleted(wf.id);
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateBefore).toBe("implementing");
      expect(result.stateAfter).toBe("gating");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("gating");
      const stateJson = row!.stateJson as Record<string, unknown>;
      expect((stateJson.gate as Record<string, unknown>).kind).toBe("review");

      // Audit events
      const events = await getWorkflowEvents({ db, workflowId: wf.id });
      expect(events.length).toBe(1);
      expect(events[0]!.eventKind).toBe("implementation_succeeded");
    });

    it("transitions implementing -> awaiting_manual_fix via run_failed", async () => {
      const wf = await createPureV2Workflow({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
        maxFixAttempts: 1,
      });

      // With maxFixAttempts=1, fixAttemptCount=0 >= maxFixAttempts-1=0 -> exhausted
      await daemonRunFailed(wf.id);
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("awaiting_manual_fix");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("awaiting_manual_fix");
    });
  });

  describe("gating phase", () => {
    it("transitions gating(review) -> gating(ci) via review_changed passed", async () => {
      const wf = await createPureV2Workflow({
        kind: "gating",
        stateJson: gatingState("review"),
      });

      await reviewPassed(wf.id);
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("gating");

      const row = await getWorkflow({ db, workflowId: wf.id });
      const stateJson = row!.stateJson as Record<string, unknown>;
      expect((stateJson.gate as Record<string, unknown>).kind).toBe("ci");
    });

    it("transitions gating(ci) -> gating(ui) via ci_changed passed", async () => {
      const wf = await createPureV2Workflow({
        kind: "gating",
        stateJson: gatingState("ci"),
      });

      await ciPassed(wf.id);
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);

      const row = await getWorkflow({ db, workflowId: wf.id });
      const stateJson = row!.stateJson as Record<string, unknown>;
      expect((stateJson.gate as Record<string, unknown>).kind).toBe("ui");
    });
  });

  describe("full lifecycle", () => {
    it("walks awaiting_plan_approval -> implementing -> gating(review) -> gating(ci) -> gating(ui) -> awaiting_pr", async () => {
      const wf = await createPureV2Workflow({
        kind: "awaiting_plan_approval",
        stateJson: {
          planVersion: 1,
          resumableFrom: { kind: "planning", planVersion: 1 },
        },
      });

      // 1. Plan approved -> implementing
      await injectSignal(wf.id, "human_resume", {
        source: "human",
        event: { kind: "plan_approved", artifactId: "plan-1" },
      });
      let result = await tick(wf.id);
      expect(result.stateAfter).toBe("implementing");

      // 2. Implementation completed -> gating(review)
      await daemonRunCompleted(wf.id);
      result = await tick(wf.id);
      expect(result.stateAfter).toBe("gating");

      // 3. Review passed -> gating(ci)
      await reviewPassed(wf.id);
      result = await tick(wf.id);
      expect(result.stateAfter).toBe("gating");

      // 4. CI passed -> gating(ui)
      await ciPassed(wf.id);
      result = await tick(wf.id);
      expect(result.stateAfter).toBe("gating");

      // 5. UI bypass -> awaiting_pr
      await injectSignal(wf.id, "human_bypass", {
        source: "human",
        event: {
          kind: "bypass_requested",
          actorUserId: "test-user",
          target: "ui",
        },
      });
      result = await tick(wf.id);
      expect(result.stateAfter).toBe("awaiting_pr");

      // Verify audit trail
      const events = await getWorkflowEvents({ db, workflowId: wf.id });
      expect(events.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("signal inbox partitioning", () => {
    it("signals keyed by workflowId are consumed by coordinator tick", async () => {
      const wf = await createPureV2Workflow({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      await daemonRunCompleted(wf.id);
      const result = await tick(wf.id);

      expect(result.signalsProcessed).toBe(1);
      expect(result.transitioned).toBe(true);
    });

    it("signals keyed by a different ID are not consumed", async () => {
      const wf = await createPureV2Workflow({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      // Inject signal under a DIFFERENT loopId
      const otherLoopId = `other-${nanoid()}`;
      await appendSignalToInbox({
        db,
        loopId: otherLoopId,
        causeType: "daemon_run_completed",
        payload: {
          source: "daemon",
          event: {
            kind: "run_completed",
            runId: "run-other",
            result: { kind: "success", headSha: "abc123", summary: "done" },
          },
        },
      });

      const result = await tick(wf.id);

      // No signals found for this workflowId
      expect(result.signalsProcessed).toBe(0);
      expect(result.transitioned).toBe(false);
      expect(result.stateAfter).toBe("implementing");
    });
  });
});
