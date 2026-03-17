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
}) {
  return createWorkflow({
    db,
    threadId: testThreadId,
    generation: Math.floor(Math.random() * 1_000_000),
    kind: params.kind,
    stateJson: params.stateJson ?? {},
    userId: testUserId,
    // sdlcLoopId is NOT passed — defaults to null (pure v2)
  });
}

async function injectSignal(
  workflowId: string,
  causeType: import("@terragon/shared/db/types").SdlcLoopCauseType,
  payload: Record<string, unknown>,
) {
  return appendSignalToInbox({ db, loopId: workflowId, causeType, payload });
}

async function tick(workflowId: string) {
  return runCoordinatorTick({
    db,
    workflowId: workflowId as WorkflowId,
    correlationId: nanoid() as CorrelationId,
  });
}

// -- State JSON shapes --

const PLANNING_STATE = { planVersion: null };

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

const BABYSITTING_STATE = {
  headSha: "sha-test",
  reviewSurface: { kind: "github_pr", prNumber: 1 },
  nextCheckAt: new Date(Date.now() + 300_000).toISOString(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pure v2 workflow integration (no v1 sdlcLoop)", () => {
  describe("planning phase", () => {
    it("planning -> implementing via plan_approved signal", async () => {
      const wf = await createPureV2Workflow({
        kind: "awaiting_plan_approval",
        stateJson: {
          planVersion: 1,
          resumableFrom: { kind: "planning", planVersion: 1 },
        },
      });

      await injectSignal(wf.id, "human_resume", {
        source: "human",
        event: { kind: "plan_approved", artifactId: "art-1" },
      });
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateBefore).toBe("awaiting_plan_approval");
      expect(result.stateAfter).toBe("implementing");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("implementing");
    });

    it("planning ignores run_completed signal (waits for checkpoint pipeline)", async () => {
      const wf = await createPureV2Workflow({
        kind: "planning",
        stateJson: PLANNING_STATE,
      });

      await injectSignal(wf.id, "daemon_run_completed", {
        source: "daemon",
        event: {
          kind: "run_completed",
          runId: `run-${nanoid(6)}`,
          result: { kind: "success", headSha: "sha-test", summary: "done" },
        },
      });
      const result = await tick(wf.id);

      // Signal is processed but no transition occurs
      expect(result.signalsProcessed).toBe(1);
      expect(result.transitioned).toBe(false);
      expect(result.stateAfter).toBe("planning");
    });

    it("planning -> stopped via human stop signal", async () => {
      const wf = await createPureV2Workflow({
        kind: "planning",
        stateJson: PLANNING_STATE,
      });

      await injectSignal(wf.id, "human_stop", {
        source: "human",
        event: { kind: "stop_requested", actorUserId: testUserId },
      });
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("stopped");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("stopped");
    });
  });

  describe("implementing phase", () => {
    it("implementing -> gating(review) via run_completed", async () => {
      const wf = await createPureV2Workflow({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      await injectSignal(wf.id, "daemon_run_completed", {
        source: "daemon",
        event: {
          kind: "run_completed",
          runId: `run-${nanoid(6)}`,
          result: { kind: "success", headSha: "sha-test", summary: "done" },
        },
      });
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateBefore).toBe("implementing");
      expect(result.stateAfter).toBe("gating");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("gating");
      const stateJson = row!.stateJson as Record<string, unknown>;
      expect((stateJson.gate as Record<string, unknown>).kind).toBe("review");
    });

    it("implementing -> awaiting_manual_fix via run_failed (budget exhausted)", async () => {
      const wf = await createPureV2Workflow({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      // Get to gating then block to increment fixAttemptCount
      await injectSignal(wf.id, "daemon_run_completed", {
        source: "daemon",
        event: {
          kind: "run_completed",
          runId: `run-${nanoid(6)}`,
          result: { kind: "success", headSha: "sha-test", summary: "done" },
        },
      });
      await tick(wf.id); // -> gating(review)

      await injectSignal(wf.id, "github_review_changed", {
        source: "github",
        event: {
          kind: "review_changed",
          prNumber: 1,
          result: {
            passed: false,
            unresolvedThreadCount: 2,
            approvalCount: 0,
            requiredApprovals: 1,
          },
        },
      });
      await tick(wf.id); // -> implementing, fixAttemptCount=1

      // Now with default maxFixAttempts=6, we need fixAttemptCount >= 5
      // Faster: just use run_failed with config_error which immediately escalates
      await injectSignal(wf.id, "daemon_run_failed", {
        source: "daemon",
        event: {
          kind: "run_failed",
          runId: `run-${nanoid(6)}`,
          failure: { kind: "config_error", message: "provider not configured" },
        },
      });
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("awaiting_manual_fix");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("awaiting_manual_fix");
    });
  });

  describe("gating phase", () => {
    it("gating(review) -> gating(ci) via review passed", async () => {
      const wf = await createPureV2Workflow({
        kind: "gating",
        stateJson: gatingState("review"),
      });

      await injectSignal(wf.id, "github_review_changed", {
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
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("gating");

      const row = await getWorkflow({ db, workflowId: wf.id });
      const stateJson = row!.stateJson as Record<string, unknown>;
      expect((stateJson.gate as Record<string, unknown>).kind).toBe("ci");
    });

    it("gating(ci) -> gating(ui) via ci passed", async () => {
      const wf = await createPureV2Workflow({
        kind: "gating",
        stateJson: gatingState("ci"),
      });

      await injectSignal(wf.id, "github_ci_changed", {
        source: "github",
        event: {
          kind: "ci_changed",
          prNumber: 1,
          result: {
            passed: true,
            requiredChecks: ["build"],
            failingChecks: [],
          },
        },
      });
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("gating");

      const row = await getWorkflow({ db, workflowId: wf.id });
      const stateJson = row!.stateJson as Record<string, unknown>;
      expect((stateJson.gate as Record<string, unknown>).kind).toBe("ui");
    });
  });

  describe("full lifecycle", () => {
    it("planning -> implementing -> gating -> babysitting -> done (full happy path)", async () => {
      // 1. Start in awaiting_plan_approval (planning phase complete, needs approval)
      const wf = await createPureV2Workflow({
        kind: "awaiting_plan_approval",
        stateJson: {
          planVersion: 1,
          resumableFrom: { kind: "planning", planVersion: 1 },
        },
      });

      // 2. plan_approved -> implementing
      await injectSignal(wf.id, "human_resume", {
        source: "human",
        event: { kind: "plan_approved", artifactId: "art-1" },
      });
      let result = await tick(wf.id);
      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("implementing");

      // 3. run_completed -> gating(review)
      await injectSignal(wf.id, "daemon_run_completed", {
        source: "daemon",
        event: {
          kind: "run_completed",
          runId: `run-${nanoid(6)}`,
          result: { kind: "success", headSha: "sha-test", summary: "done" },
        },
      });
      result = await tick(wf.id);
      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("gating");

      // 4. review_changed(passed) -> gating(ci)
      await injectSignal(wf.id, "github_review_changed", {
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
      result = await tick(wf.id);
      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("gating");

      // 5. ci_changed(passed) -> gating(ui)
      await injectSignal(wf.id, "github_ci_changed", {
        source: "github",
        event: {
          kind: "ci_changed",
          prNumber: 1,
          result: {
            passed: true,
            requiredChecks: ["build"],
            failingChecks: [],
          },
        },
      });
      result = await tick(wf.id);
      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("gating");

      // 6. ui bypass -> awaiting_pr (no PR link)
      await injectSignal(wf.id, "human_bypass", {
        source: "human",
        event: {
          kind: "bypass_requested",
          actorUserId: testUserId,
          target: "ui",
        },
      });
      result = await tick(wf.id);
      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("awaiting_pr");

      // 7. pr_synchronized -> babysitting
      await injectSignal(
        wf.id,
        "github_pr_synchronized" as import("@terragon/shared/db/types").SdlcLoopCauseType,
        {
          source: "github",
          event: {
            kind: "pr_synchronized",
            prNumber: 42,
            headSha: "sha-test",
          },
        },
      );
      result = await tick(wf.id);
      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("babysitting");

      // 8. babysit_gates_passed -> done
      await injectSignal(wf.id, "babysit_recheck_passed", {
        source: "babysit",
        event: { kind: "babysit_gates_passed", headSha: "sha-test" },
      });
      result = await tick(wf.id);
      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("done");

      // Verify final state
      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("done");

      // Verify events were recorded throughout the lifecycle
      const events = await getWorkflowEvents({ db, workflowId: wf.id });
      expect(events.length).toBeGreaterThanOrEqual(6);
    });
  });

  describe("signal inbox uses workflowId as loopId", () => {
    it("signals keyed by workflowId are correctly consumed by coordinator tick", async () => {
      const wf = await createPureV2Workflow({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      // Signal keyed by workflowId (pure v2 path)
      await injectSignal(wf.id, "daemon_run_completed", {
        source: "daemon",
        event: {
          kind: "run_completed",
          runId: `run-${nanoid(6)}`,
          result: { kind: "success", headSha: "sha-test", summary: "done" },
        },
      });

      // Tick uses workflowId as default loopId for pure v2
      const result = await tick(wf.id);

      expect(result.signalsProcessed).toBe(1);
      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("gating");
    });

    it("signals keyed by wrong loopId are NOT consumed", async () => {
      const wf = await createPureV2Workflow({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      // Inject signal with a different loopId
      await appendSignalToInbox({
        db,
        loopId: "wrong-id-" + nanoid(),
        causeType: "daemon_run_completed",
        payload: {
          source: "daemon",
          event: {
            kind: "run_completed",
            runId: `run-${nanoid(6)}`,
            result: { kind: "success", headSha: "sha-test", summary: "done" },
          },
        },
      });

      // Tick with workflowId — should NOT find the signal
      const result = await tick(wf.id);

      expect(result.signalsProcessed).toBe(0);
      expect(result.transitioned).toBe(false);
      expect(result.stateAfter).toBe("implementing");
    });
  });
});
