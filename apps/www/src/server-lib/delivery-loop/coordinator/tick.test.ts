import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import * as githubHelpers from "@/lib/github";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { updateThread } from "@terragon/shared/model/threads";
import {
  createWorkflow,
  getWorkflow,
  updateWorkflowState,
} from "@terragon/shared/delivery-loop/store/workflow-store";
import { appendSignalToInbox } from "@terragon/shared/delivery-loop/store/signal-inbox-store";
import { getWorkflowEvents } from "@terragon/shared/delivery-loop/store/event-store";
import { getRuntimeStatus } from "@terragon/shared/delivery-loop/store/runtime-status-store";
import * as schema from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
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

async function createTestWorkflowInState(params: {
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
  causeType: import("@terragon/shared/db/types").DeliveryLoopCauseType,
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

function reviewBlocked(workflowId: string) {
  return injectSignal(workflowId, "github_review_changed", {
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

/** Human bypass for a specific gate — useful for ui gate which has no signal mapping */
function humanBypass(workflowId: string, gate: "review" | "ci" | "ui") {
  return injectSignal(workflowId, "human_bypass", {
    source: "human",
    event: { kind: "bypass_requested", actorUserId: "test-user", target: gate },
  });
}

function humanStop(workflowId: string) {
  return injectSignal(workflowId, "human_stop", {
    source: "human",
    event: { kind: "stop_requested", actorUserId: "test-user" },
  });
}

function humanResume(workflowId: string) {
  return injectSignal(workflowId, "human_resume", {
    source: "human",
    event: { kind: "resume_requested", actorUserId: "test-user" },
  });
}

function prMerged(workflowId: string) {
  return injectSignal(workflowId, "github_pr_closed", {
    source: "github",
    event: { kind: "pr_closed", prNumber: 1, merged: true },
  });
}

function prClosedUnmerged(workflowId: string) {
  return injectSignal(workflowId, "github_pr_closed", {
    source: "github",
    event: { kind: "pr_closed", prNumber: 1, merged: false },
  });
}

async function tick(workflowId: string, corrId?: CorrelationId) {
  return runCoordinatorTick({
    db,
    workflowId: workflowId as WorkflowId,
    correlationId: corrId ?? correlationId(),
  });
}

async function tickWithClaim(
  workflowId: string,
  claimToken: string,
  corrId?: CorrelationId,
) {
  return runCoordinatorTick({
    db,
    workflowId: workflowId as WorkflowId,
    correlationId: corrId ?? correlationId(),
    claimToken,
  });
}

async function tickWithSkipGates(workflowId: string) {
  return runCoordinatorTick({
    db,
    workflowId: workflowId as WorkflowId,
    correlationId: correlationId(),
    skipGates: true,
  });
}

// -- Reusable state builders --

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
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  const { user } = await createTestUser({ db });
  const { threadId } = await createTestThread({ db, userId: user.id });
  testUserId = user.id;
  testThreadId = threadId;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("v2 coordinator tick — integration", () => {
  describe("happy path: implementing -> done", () => {
    it("implementing -> gating(review) via implementation_completed", async () => {
      const wf = await createTestWorkflowInState({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      await daemonRunCompleted(wf.id);
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateBefore).toBe("implementing");
      expect(result.stateAfter).toBe("gating");
      expect(result.signalsProcessed).toBe(1);

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("gating");
      expect(row!.version).toBe(1);
      const stateJson = row!.stateJson as Record<string, unknown>;
      expect((stateJson.gate as Record<string, unknown>).kind).toBe("review");

      // Audit events
      const events = await getWorkflowEvents({ db, workflowId: wf.id });
      expect(events.length).toBe(1);
      expect(events[0]!.eventKind).toBe("implementation_succeeded");
      expect(events[0]!.stateBefore).toBe("implementing");
      expect(events[0]!.stateAfter).toBe("gating");

      // Work items: 2 publications (gates are webhook-driven, no dispatch)
      const workItems = await db.query.deliveryWorkItem.findMany({
        where: eq(schema.deliveryWorkItem.workflowId, wf.id),
      });
      expect(workItems.filter((w) => w.kind === "publication").length).toBe(2);

      // Runtime status
      const status = await getRuntimeStatus({ db, workflowId: wf.id });
      expect(status!.state).toBe("gating");
      expect(status!.gate).toBe("review");
    });

    it("gating(review) -> gating(ci) via gate_passed", async () => {
      const wf = await createTestWorkflowInState({
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
      expect(row!.fixAttemptCount).toBe(0);
    });

    it("gating(ci) -> gating(ui) via gate_passed", async () => {
      const wf = await createTestWorkflowInState({
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

    it("gating(ui) -> awaiting_pr via human bypass (no PR link)", async () => {
      const wf = await createTestWorkflowInState({
        kind: "gating",
        stateJson: gatingState("ui"),
      });

      // UI gate has no direct signal mapping, use human bypass
      await humanBypass(wf.id, "ui");
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("awaiting_pr");
    });

    it("babysitting -> done via babysit_gates_passed", async () => {
      const wf = await createTestWorkflowInState({
        kind: "babysitting",
        stateJson: BABYSITTING_STATE,
      });

      // Only the babysit worker's aggregate evaluation produces transitions.
      // Raw GitHub ci_changed/review_changed signals are suppressed in babysitting.
      await injectSignal(wf.id, "babysit_recheck_passed", {
        source: "babysit",
        event: { kind: "babysit_gates_passed", headSha: "abc123" },
      });
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("done");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("done");
    });

    it("babysitting -> implementing via babysit_gates_blocked", async () => {
      const wf = await createTestWorkflowInState({
        kind: "babysitting",
        stateJson: BABYSITTING_STATE,
      });

      await injectSignal(wf.id, "babysit_recheck_blocked", {
        source: "babysit",
        event: { kind: "babysit_gates_blocked", headSha: "abc123" },
      });
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("implementing");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("implementing");
    });
  });

  describe("gate blocked -> fix cycle -> retry", () => {
    it("review blocked sends back to implementing with incremented fixAttemptCount", async () => {
      const wf = await createTestWorkflowInState({
        kind: "gating",
        stateJson: gatingState("review"),
      });

      await reviewBlocked(wf.id);
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("implementing");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.fixAttemptCount).toBe(1);
    });

    it("fix cycle: block -> impl -> gating -> pass continues forward", async () => {
      const wf = await createTestWorkflowInState({
        kind: "gating",
        stateJson: gatingState("review"),
      });

      // Block -> implementing (fixAttemptCount=1)
      await reviewBlocked(wf.id);
      await tick(wf.id);

      // Fix -> gating(review) — implementation_completed resets fixAttemptCount
      await daemonRunCompleted(wf.id);
      await tick(wf.id);

      // Pass review -> gating(ci)
      await reviewPassed(wf.id);
      const result = await tick(wf.id);

      expect(result.stateAfter).toBe("gating");
      const row = await getWorkflow({ db, workflowId: wf.id });
      const stateJson = row!.stateJson as Record<string, unknown>;
      expect((stateJson.gate as Record<string, unknown>).kind).toBe("ci");
      expect(row!.fixAttemptCount).toBe(0);
    });
  });

  describe("retry budget exhaustion -> awaiting_manual_fix", () => {
    it("exhausts fix budget via daemon run_failed and enters awaiting_manual_fix", async () => {
      // Start in implementing with fixAttemptCount already near budget
      // maxFixAttempts=2: run_failed checks fixAttemptCount >= maxFixAttempts - 1 (i.e. >= 1)
      const wf = await createTestWorkflowInState({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
        maxFixAttempts: 2,
      });

      // First: get to gating, then block to increment fixAttemptCount to 1
      await daemonRunCompleted(wf.id);
      await tick(wf.id); // -> gating(review)

      await reviewBlocked(wf.id);
      await tick(wf.id); // -> implementing, fixAttemptCount=1

      // Now run_failed with fixAttemptCount=1 >= maxFixAttempts-1=1 -> exhausted_retries
      await daemonRunFailed(wf.id);
      const result = await tick(wf.id);

      expect(result.stateAfter).toBe("awaiting_manual_fix");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("awaiting_manual_fix");
    });
  });

  describe("human intervention: resume from awaiting_manual_fix", () => {
    it("resumes to implementing from awaiting_manual_fix", async () => {
      const wf = await createTestWorkflowInState({
        kind: "awaiting_manual_fix",
        stateJson: {
          reason: {
            description: "Retry budget exhausted",
            suggestedAction: "Fix manually",
          },
          resumableFrom: {
            kind: "implementing",
            dispatchId: "d-resume",
          },
        },
      });

      await humanResume(wf.id);
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("implementing");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("implementing");
    });
  });

  describe("plan approval: awaiting_plan_approval -> implementing", () => {
    it("awaiting_plan_approval -> implementing via plan_approved human signal", async () => {
      const wf = await createTestWorkflowInState({
        kind: "awaiting_plan_approval",
        stateJson: {
          planVersion: 1,
          resumableFrom: { kind: "planning", planVersion: 1 },
        },
      });

      // Inject a plan_approved human signal
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
      const stateJson = row!.stateJson as Record<string, unknown>;
      expect(stateJson.planVersion).toBe(1);
      expect((stateJson.dispatch as Record<string, unknown>).kind).toBe(
        "queued",
      );

      // Work items: dispatch should be scheduled
      const workItems = await db.query.deliveryWorkItem.findMany({
        where: eq(schema.deliveryWorkItem.workflowId, wf.id),
      });
      expect(workItems.some((w) => w.kind === "dispatch")).toBe(true);
    });
  });

  describe("plan artifact creation on planning -> implementing", () => {
    it("creates deliveryPhaseArtifact and deliveryPlanTask rows when planning transitions to implementing", async () => {
      const wf = await createTestWorkflowInState({
        kind: "planning",
        stateJson: {},
      });

      // Set up thread chat messages with a Write tool call to plans/*.md
      // that extractLatestPlanText can parse (Priority 2: standalone Write)
      const planContent = JSON.stringify({
        tasks: [
          {
            stableTaskId: "task-1",
            title: "Implement feature A",
            description: "Add the new feature",
            acceptance: ["it compiles", "tests pass"],
          },
          {
            stableTaskId: "task-2",
            title: "Write tests for feature A",
            description: "Cover edge cases",
            acceptance: ["coverage above 80%"],
          },
        ],
      });

      const planMessages = [
        {
          type: "tool-call" as const,
          id: `write-${nanoid(6)}`,
          name: "Write",
          parameters: {
            file_path: "/workspace/plans/plan.md",
            content: planContent,
          },
          parent_tool_use_id: null,
        },
      ];

      // Insert a threadChat row (tick.ts queries threadChat, not the thread table)
      await db.insert(schema.threadChat).values({
        userId: testUserId,
        threadId: testThreadId,
        messages: planMessages,
      });

      // Inject daemon run completed signal and tick
      await daemonRunCompleted(wf.id);
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateBefore).toBe("planning");
      expect(result.stateAfter).toBe("implementing");

      // Assert plan artifact was created
      const artifact = await db.query.deliveryPhaseArtifact.findFirst({
        where: eq(schema.deliveryPhaseArtifact.loopId, wf.id),
      });
      expect(artifact).toBeDefined();
      expect(artifact!.phase).toBe("planning");
      expect(artifact!.status).toBe("accepted");

      // Assert plan tasks were created
      const tasks = await db.query.deliveryPlanTask.findMany({
        where: eq(schema.deliveryPlanTask.loopId, wf.id),
      });
      expect(tasks.length).toBe(2);

      const taskIds = tasks.map((t) => t.stableTaskId).sort();
      expect(taskIds).toEqual(["task-1", "task-2"]);

      const task1 = tasks.find((t) => t.stableTaskId === "task-1");
      expect(task1!.title).toBe("Implement feature A");

      const task2 = tasks.find((t) => t.stableTaskId === "task-2");
      expect(task2!.title).toBe("Write tests for feature A");
    });
  });

  describe("manual stop", () => {
    it("implementing -> stopped via manual_stop", async () => {
      const wf = await createTestWorkflowInState({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      await humanStop(wf.id);
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("stopped");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("stopped");

      // Terminal state: further signals should not cause transitions
      await daemonRunCompleted(wf.id);
      const result2 = await tick(wf.id);
      expect(result2.transitioned).toBe(false);
    });
  });

  describe("PR lifecycle events", () => {
    it("babysitting -> terminated via pr_merged", async () => {
      const wf = await createTestWorkflowInState({
        kind: "babysitting",
        stateJson: BABYSITTING_STATE,
      });

      await prMerged(wf.id);
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("terminated");

      const events = await getWorkflowEvents({ db, workflowId: wf.id });
      expect(events.some((e) => e.eventKind === "workflow_terminated")).toBe(
        true,
      );
    });

    it("babysitting -> terminated via pr_closed (unmerged)", async () => {
      const wf = await createTestWorkflowInState({
        kind: "babysitting",
        stateJson: BABYSITTING_STATE,
      });

      await prClosedUnmerged(wf.id);
      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("terminated");
    });
  });

  describe("unrecognized signal -> dead letter", () => {
    it("dead-letters an unknown causeType signal", async () => {
      const wf = await createTestWorkflowInState({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      await injectSignal(
        wf.id,
        "totally_unknown_cause_type" as import("@terragon/shared/db/types").DeliveryLoopCauseType,
        { foo: "bar" },
      );
      const result = await tick(wf.id);

      expect(result.signalsProcessed).toBe(1);
      expect(result.transitioned).toBe(false);

      const signals = await db.query.deliverySignalInbox.findMany({
        where: eq(schema.deliverySignalInbox.loopId, wf.id),
      });
      expect(signals.some((s) => s.deadLetteredAt !== null)).toBe(true);
    });
  });

  describe("version conflict (optimistic concurrency)", () => {
    it("updateWorkflowState rejects stale version", async () => {
      const wf = await createTestWorkflowInState({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      // Bump version from 0 -> 1
      await updateWorkflowState({
        db,
        workflowId: wf.id,
        expectedVersion: 0,
        kind: "implementing",
        stateJson: wf.stateJson as Record<string, unknown>,
      });

      // Attempt update with stale version 0
      const result = await updateWorkflowState({
        db,
        workflowId: wf.id,
        expectedVersion: 0,
        kind: "gating",
        stateJson: {},
      });
      expect(result).toEqual({ updated: false, reason: "version_conflict" });
    });
  });

  describe("no signals -> noop tick", () => {
    it("processes zero signals and does not transition", async () => {
      const wf = await createTestWorkflowInState({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      const result = await tick(wf.id);

      expect(result.signalsProcessed).toBe(0);
      expect(result.transitioned).toBe(false);
      expect(result.stateBefore).toBe("implementing");
      expect(result.stateAfter).toBe("implementing");
      expect(result.workItemsScheduled).toBe(0);

      const status = await getRuntimeStatus({ db, workflowId: wf.id });
      expect(status).toBeDefined();
      expect(status!.state).toBe("implementing");
    });
  });

  describe("awaiting_pr invariant middleware", () => {
    it("awaiting_pr + no diff + no PR => auto mark_done -> done", async () => {
      const wf = await createTestWorkflowInState({
        kind: "awaiting_pr",
        stateJson: { headSha: "sha-test" },
      });

      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateBefore).toBe("awaiting_pr");
      expect(result.stateAfter).toBe("done");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("done");

      const events = await getWorkflowEvents({ db, workflowId: wf.id });
      const invariantEvent = events.find(
        (event) => event.eventKind === "awaiting_pr_invariant",
      );
      expect(invariantEvent).toBeDefined();
      expect(invariantEvent!.payloadJson).toMatchObject({
        kind: "awaiting_pr_invariant_no_diff",
      });
    });

    it("awaiting_pr + thread PR linked => auto pr_linked -> babysitting", async () => {
      await updateThread({
        db,
        userId: testUserId,
        threadId: testThreadId,
        updates: {
          githubPRNumber: 42,
        },
      });

      const wf = await createTestWorkflowInState({
        kind: "awaiting_pr",
        stateJson: { headSha: "sha-test" },
      });

      const result = await tick(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateBefore).toBe("awaiting_pr");
      expect(result.stateAfter).toBe("babysitting");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("babysitting");
      expect(row!.prNumber).toBe(42);

      const events = await getWorkflowEvents({ db, workflowId: wf.id });
      const invariantEvent = events.find(
        (event) => event.eventKind === "awaiting_pr_invariant",
      );
      expect(invariantEvent).toBeDefined();
      expect(invariantEvent!.payloadJson).toMatchObject({
        kind: "awaiting_pr_invariant_pr_linked",
      });
    });

    it("awaiting_pr + PR link failure => awaiting_operator_action", async () => {
      await updateThread({
        db,
        userId: testUserId,
        threadId: testThreadId,
        updates: {
          branchName: "feature/test-pr-link",
          gitDiff: "diff --git a/file.ts b/file.ts",
        },
      });

      const existingPrSpy = vi
        .spyOn(githubHelpers, "getExistingPRForBranch")
        .mockRejectedValueOnce(new Error("GitHub unavailable"));

      const wf = await createTestWorkflowInState({
        kind: "awaiting_pr",
        stateJson: { headSha: "sha-test" },
      });

      const result = await tick(wf.id);

      expect(existingPrSpy).toHaveBeenCalledOnce();
      expect(result.transitioned).toBe(true);
      expect(result.stateBefore).toBe("awaiting_pr");
      expect(result.stateAfter).toBe("awaiting_operator_action");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row).not.toBeNull();
      if (!row) {
        throw new Error("workflow row missing");
      }
      expect(row.kind).toBe("awaiting_operator_action");
      expect(row.stateJson).toMatchObject({
        reason: {
          description: "GitHub unavailable",
          system: "github",
        },
      });

      const events = await getWorkflowEvents({ db, workflowId: wf.id });
      const invariantEvent = events.find(
        (event) => event.eventKind === "awaiting_pr_invariant",
      );
      expect(invariantEvent).toBeDefined();
      expect(invariantEvent!.payloadJson).toMatchObject({
        kind: "awaiting_pr_invariant_operator_action",
        reason: "GitHub unavailable",
      });
    });

    it("awaiting_pr + clean diff stats + branch commits => creates/links PR", async () => {
      await updateThread({
        db,
        userId: testUserId,
        threadId: testThreadId,
        updates: {
          branchName: "feature/pr-from-clean-tree",
          gitDiff: "",
          gitDiffStats: { files: 0, additions: 0, deletions: 0 },
        },
      });

      const getExistingPrSpy = vi
        .spyOn(githubHelpers, "getExistingPRForBranch")
        .mockResolvedValueOnce(null);
      vi.spyOn(githubHelpers, "getDefaultBranchForRepo").mockResolvedValueOnce(
        "main",
      );
      const createPullSpy = vi.fn().mockResolvedValue({
        data: {
          number: 123,
          state: "open",
          draft: true,
        },
      });
      const octokitMock = {
        rest: {
          pulls: {
            create: createPullSpy,
          },
        },
      } as unknown as Awaited<
        ReturnType<typeof githubHelpers.getOctokitForUserOrThrow>
      >;
      vi.spyOn(githubHelpers, "getOctokitForUserOrThrow").mockResolvedValueOnce(
        octokitMock,
      );

      const wf = await createTestWorkflowInState({
        kind: "awaiting_pr",
        stateJson: { headSha: "sha-test" },
      });

      const result = await tick(wf.id);

      expect(getExistingPrSpy).toHaveBeenCalledOnce();
      expect(createPullSpy).toHaveBeenCalledOnce();
      expect(result.transitioned).toBe(true);
      expect(result.stateBefore).toBe("awaiting_pr");
      expect(result.stateAfter).toBe("babysitting");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row).not.toBeNull();
      if (!row) {
        throw new Error("workflow row missing");
      }
      expect(row.kind).toBe("babysitting");
      expect(row.prNumber).toBe(123);

      const threadRow = await db.query.thread.findFirst({
        where: eq(schema.thread.id, testThreadId),
      });
      expect(threadRow?.githubPRNumber).toBe(123);

      const events = await getWorkflowEvents({ db, workflowId: wf.id });
      const invariantEvent = events.find(
        (event) => event.eventKind === "awaiting_pr_invariant",
      );
      expect(invariantEvent).toBeDefined();
      expect(invariantEvent!.payloadJson).toMatchObject({
        kind: "awaiting_pr_invariant_pr_linked",
      });
    });

    it("awaiting_pr + user-oauth failure => falls back to app auth for PR create", async () => {
      await updateThread({
        db,
        userId: testUserId,
        threadId: testThreadId,
        updates: {
          branchName: "feature/pr-via-app-fallback",
          gitDiff: "",
          gitDiffStats: { files: 0, additions: 0, deletions: 0 },
        },
      });

      vi.spyOn(githubHelpers, "getExistingPRForBranch").mockResolvedValueOnce(
        null,
      );
      vi.spyOn(githubHelpers, "getDefaultBranchForRepo").mockResolvedValueOnce(
        "main",
      );
      vi.spyOn(githubHelpers, "getOctokitForUserOrThrow").mockRejectedValueOnce(
        new Error("Invalid keyData"),
      );

      const createPullSpy = vi.fn().mockResolvedValue({
        data: {
          number: 321,
          state: "open",
          draft: true,
        },
      });
      const appOctokitMock = {
        rest: {
          pulls: {
            create: createPullSpy,
          },
        },
      } as unknown as Awaited<
        ReturnType<typeof githubHelpers.getOctokitForApp>
      >;
      const appFallbackSpy = vi
        .spyOn(githubHelpers, "getOctokitForApp")
        .mockResolvedValueOnce(appOctokitMock);

      const wf = await createTestWorkflowInState({
        kind: "awaiting_pr",
        stateJson: { headSha: "sha-test" },
      });

      const result = await tick(wf.id);

      expect(appFallbackSpy).toHaveBeenCalledOnce();
      expect(createPullSpy).toHaveBeenCalledOnce();
      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("babysitting");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row?.prNumber).toBe(321);
    });

    it("awaiting_pr + clean diff stats + no commits between branches => done", async () => {
      await updateThread({
        db,
        userId: testUserId,
        threadId: testThreadId,
        updates: {
          branchName: "feature/no-commits",
          gitDiff: "",
          gitDiffStats: { files: 0, additions: 0, deletions: 0 },
        },
      });

      vi.spyOn(githubHelpers, "getExistingPRForBranch").mockResolvedValueOnce(
        null,
      );
      vi.spyOn(githubHelpers, "getDefaultBranchForRepo").mockResolvedValueOnce(
        "main",
      );
      const createError = new Error(
        "Validation Failed: No commits between main and feature/no-commits",
      );
      const createPullSpy = vi.fn().mockRejectedValueOnce(createError);
      const octokitMock = {
        rest: {
          pulls: {
            create: createPullSpy,
          },
        },
      } as unknown as Awaited<
        ReturnType<typeof githubHelpers.getOctokitForUserOrThrow>
      >;
      vi.spyOn(githubHelpers, "getOctokitForUserOrThrow").mockResolvedValueOnce(
        octokitMock,
      );

      const wf = await createTestWorkflowInState({
        kind: "awaiting_pr",
        stateJson: { headSha: "sha-test" },
      });

      const result = await tick(wf.id);

      expect(createPullSpy).toHaveBeenCalledOnce();
      expect(result.transitioned).toBe(true);
      expect(result.stateBefore).toBe("awaiting_pr");
      expect(result.stateAfter).toBe("done");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row).not.toBeNull();
      if (!row) {
        throw new Error("workflow row missing");
      }
      expect(row.kind).toBe("done");

      const events = await getWorkflowEvents({ db, workflowId: wf.id });
      const invariantEvent = events.find(
        (event) => event.eventKind === "awaiting_pr_invariant",
      );
      expect(invariantEvent).toBeDefined();
      expect(invariantEvent!.payloadJson).toMatchObject({
        kind: "awaiting_pr_invariant_no_diff",
      });
    });
  });

  describe("multiple signals in single tick", () => {
    it("processes multiple signals sequentially within one tick", async () => {
      // implementing -> gating(review) -> gating(ci) in one tick
      const wf = await createTestWorkflowInState({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      // Signal 1: implementation_completed -> gating(review)
      await daemonRunCompleted(wf.id);
      // Signal 2: review_changed passed -> gating(ci)
      // This will be processed after the first signal transitions to gating(review)
      await reviewPassed(wf.id);

      const result = await tick(wf.id);

      expect(result.signalsProcessed).toBe(2);
      expect(result.transitioned).toBe(true);
      expect(result.stateBefore).toBe("implementing");
      expect(result.stateAfter).toBe("gating");

      const events = await getWorkflowEvents({ db, workflowId: wf.id });
      expect(events.length).toBe(2);
      expect(events[0]!.stateBefore).toBe("implementing");
      expect(events[0]!.stateAfter).toBe("gating");
      expect(events[1]!.stateBefore).toBe("gating");
      expect(events[1]!.stateAfter).toBe("gating");
    });
  });

  describe("concurrent coordinator claims", () => {
    it("preserves a single logical transition when two workers race on the same signal", async () => {
      const wf = await createTestWorkflowInState({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });
      await daemonRunCompleted(wf.id);

      const [firstTick, secondTick] = await Promise.all([
        tickWithClaim(wf.id, "worker-a"),
        tickWithClaim(wf.id, "worker-b"),
      ]);

      const transitionedCount =
        Number(firstTick.transitioned) + Number(secondTick.transitioned);
      const signalsProcessedCount =
        firstTick.signalsProcessed + secondTick.signalsProcessed;
      expect(transitionedCount).toBe(1);
      expect(signalsProcessedCount).toBe(1);

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row?.kind).toBe("gating");

      const events = await getWorkflowEvents({ db, workflowId: wf.id });
      expect(events).toHaveLength(1);
      expect(events[0]!.eventKind).toBe("implementation_succeeded");
    });
  });

  describe("runtime status + audit events", () => {
    it("upserts runtime status with correct gate", async () => {
      const wf = await createTestWorkflowInState({
        kind: "gating",
        stateJson: gatingState("review"),
      });

      await reviewPassed(wf.id);
      await tick(wf.id);

      const status = await getRuntimeStatus({ db, workflowId: wf.id });
      expect(status!.state).toBe("gating");
      expect(status!.gate).toBe("ci");
    });

    it("records audit events with correlationId and trigger source", async () => {
      const wf = await createTestWorkflowInState({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      const corrId = correlationId();
      await daemonRunCompleted(wf.id);
      await tick(wf.id, corrId);

      const events = await getWorkflowEvents({ db, workflowId: wf.id });
      expect(events.length).toBe(1);
      expect(events[0]!.correlationId).toBe(corrId);
      expect(events[0]!.triggerSource).toBe("daemon");
    });
  });

  describe("work items scheduled", () => {
    it("schedules dispatch + publication work items on state change", async () => {
      const wf = await createTestWorkflowInState({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      await daemonRunCompleted(wf.id);
      const result = await tick(wf.id);

      // Gates are webhook-driven — no dispatch, only 2 publications
      expect(result.workItemsScheduled).toBeGreaterThanOrEqual(2);

      const workItems = await db.query.deliveryWorkItem.findMany({
        where: eq(schema.deliveryWorkItem.workflowId, wf.id),
      });
      // 2 publications (status_comment, check_run_summary) — no dispatch for gating
      expect(workItems.filter((w) => w.kind === "publication").length).toBe(2);
      expect(workItems.every((w) => w.status === "pending")).toBe(true);
    });
  });

  describe("skipGates: auto-bypass all gates in single tick", () => {
    it("cascades through review -> ci -> ui -> awaiting_pr when skipGates enabled", async () => {
      const wf = await createTestWorkflowInState({
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
      });

      // implementation_completed -> gating(review), then auto-bypass cascades
      await daemonRunCompleted(wf.id);
      const result = await tickWithSkipGates(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateBefore).toBe("implementing");
      // All 3 gates bypassed — ends at awaiting_pr (no PR link)
      expect(result.stateAfter).toBe("awaiting_pr");
      // 1 impl_completed + 3 bypass signals = 4 signals processed
      expect(result.signalsProcessed).toBe(4);

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("awaiting_pr");

      // Audit events should show the full cascade
      const events = await getWorkflowEvents({ db, workflowId: wf.id });
      expect(events.length).toBe(4); // impl_completed + 3 gate transitions
    });

    it("level-triggered: bypasses gates when workflow is already in gating with no signals", async () => {
      // Simulate a workflow already stuck in gating(review) with no pending
      // signals — the flag was enabled after the transition into gating.
      const wf = await createTestWorkflowInState({
        kind: "gating",
        stateJson: gatingState("review"),
      });

      const result = await tickWithSkipGates(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateBefore).toBe("gating");
      // All 3 gates bypassed — ends at awaiting_pr (no PR link)
      expect(result.stateAfter).toBe("awaiting_pr");
      // 3 bypass signals processed (review, ci, ui)
      expect(result.signalsProcessed).toBe(3);

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("awaiting_pr");

      const events = await getWorkflowEvents({ db, workflowId: wf.id });
      expect(events.length).toBe(3);
    });

    it("level-triggered: bypasses from gating(ci) through remaining gates", async () => {
      // Workflow stuck at ci gate — should bypass ci and ui
      const wf = await createTestWorkflowInState({
        kind: "gating",
        stateJson: gatingState("ci"),
      });

      const result = await tickWithSkipGates(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("awaiting_pr");
      // 2 bypass signals: ci -> ui -> awaiting_pr
      expect(result.signalsProcessed).toBe(2);
    });

    it("cascades to babysitting when PR link exists", async () => {
      // Create workflow with a PR number so hasPrLink is true
      const wf = await createWorkflow({
        db,
        threadId: testThreadId,
        generation: Math.floor(Math.random() * 1_000_000),
        kind: "implementing",
        stateJson: IMPLEMENTING_STATE,
        userId: testUserId,
        prNumber: 42,
      });

      await daemonRunCompleted(wf.id);
      const result = await tickWithSkipGates(wf.id);

      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("babysitting");

      const row = await getWorkflow({ db, workflowId: wf.id });
      expect(row!.kind).toBe("babysitting");
    });
  });
});
