/**
 * V2 Delivery Loop — End-to-End Pipeline Validation
 *
 * Tests the full wired pipeline:
 *   enrollment → ingress → coordinator tick → state transition → work items
 *
 * Unlike tick.test.ts (which tests the coordinator in isolation by injecting
 * signals directly), this suite validates that:
 *   - Enrollment creates delivery_workflow rows
 *   - Ingress adapters normalize raw events into the correct signal format
 *   - Coordinator tick consumes those signals and transitions state
 *   - Work items are scheduled with correct payloads
 *   - Work items are claimable from the work queue
 *   - The full lifecycle (implementing → gating → babysitting → done) works end-to-end
 */
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
import { getRuntimeStatus } from "@terragon/shared/delivery-loop/store/runtime-status-store";
import {
  claimNextWorkItem,
  completeWorkItem,
} from "@terragon/shared/delivery-loop/store/work-queue-store";
import * as schema from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid/non-secure";
import { runCoordinatorTick } from "./tick";
import {
  normalizeDaemonEvent,
  handleDaemonIngress,
  type DaemonEventPayload,
} from "../adapters/ingress/daemon-ingress";
import {
  normalizeGitHubWebhook,
  type GitHubWebhookPayload,
} from "../adapters/ingress/github-ingress";
import {
  ensureV2WorkflowExists,
  buildInitialStateJson,
  mapV1StateToV2Kind,
} from "./enrollment-bridge";
import type {
  WorkflowId,
  CorrelationId,
} from "@terragon/shared/delivery-loop/domain/workflow";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let testUserId: string;
let testThreadId: string;

beforeEach(async () => {
  const { user } = await createTestUser({ db });
  const { threadId } = await createTestThread({ db, userId: user.id });
  testUserId = user.id;
  testThreadId = threadId;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corrId(): CorrelationId {
  return nanoid() as CorrelationId;
}

async function tick(workflowId: string) {
  return runCoordinatorTick({
    db,
    workflowId: workflowId as WorkflowId,
    correlationId: corrId(),
  });
}

/** Stable loop ID per test — derived from testThreadId so it's unique per test
 *  but consistent across calls within the same test (needed for idempotency). */
const stableLoopId = () => `sdlc-${testThreadId}`;

/** Create a workflow via the enrollment bridge (same path as production). */
async function enrollWorkflow(
  kind: string = "implementing",
  sdlcState: string = "implementing",
  sdlcLoopId: string = stableLoopId(),
) {
  const result = await ensureV2WorkflowExists({
    db,
    threadId: testThreadId,
    sdlcLoopId,
    sdlcLoopState: sdlcState as Parameters<
      typeof ensureV2WorkflowExists
    >[0]["sdlcLoopState"],
  });
  return result;
}

/** Inject a signal via daemon ingress adapter (same path as production). */
async function injectDaemonEvent(
  workflowId: string,
  payload: DaemonEventPayload,
) {
  return handleDaemonIngress({
    db,
    rawEvent: { ...payload, loopId: workflowId, threadId: testThreadId },
    workflowId:
      workflowId as import("@terragon/shared/delivery-loop/domain/workflow").WorkflowId,
  });
}

/** Inject a signal directly into inbox (for GitHub events that need manual wiring). */
async function injectGitHubSignal(
  workflowId: string,
  rawEvent: GitHubWebhookPayload,
) {
  const signal = normalizeGitHubWebhook(rawEvent);
  if (!signal)
    throw new Error(`GitHub event not recognized: ${rawEvent.action}`);

  const causeTypeMap: Record<
    string,
    import("@terragon/shared/db/types").SdlcLoopCauseType
  > = {
    ci_changed: "github_ci_changed",
    review_changed: "github_review_changed",
    pr_closed: "github_pr_closed",
    pr_synchronized: "github_pr_synchronized",
  };

  const causeType = causeTypeMap[signal.event.kind];
  if (!causeType)
    throw new Error(`Unknown GitHub signal kind: ${signal.event.kind}`);

  await appendSignalToInbox({
    db,
    loopId: workflowId,
    causeType,
    payload: signal as Record<string, unknown>,
  });
}

/** Get all pending work items for a workflow. */
async function getPendingWorkItems(workflowId: string) {
  return db.query.deliveryWorkItem.findMany({
    where: eq(schema.deliveryWorkItem.workflowId, workflowId),
  });
}

/** Assert workflow is in expected state. */
async function assertWorkflowState(
  workflowId: string,
  expectedKind: string,
  gate?: string,
) {
  const row = await getWorkflow({ db, workflowId });
  expect(row).toBeDefined();
  expect(row!.kind).toBe(expectedKind);
  if (gate) {
    const stateJson = row!.stateJson as Record<string, unknown>;
    expect((stateJson.gate as Record<string, unknown>).kind).toBe(gate);
  }
  return row!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("v2 pipeline — end-to-end validation", () => {
  describe("enrollment bridge", () => {
    it("creates a workflow via enrollment bridge", async () => {
      const result = await enrollWorkflow("implementing");

      expect(result.created).toBe(true);
      expect(result.workflowId).toBeDefined();

      const wf = await getWorkflow({ db, workflowId: result.workflowId });
      expect(wf).toBeDefined();
      expect(wf!.kind).toBe("implementing");
      expect(wf!.threadId).toBe(testThreadId);
    });

    it("enrollment is idempotent — second call returns existing", async () => {
      const first = await enrollWorkflow("implementing");
      const second = await enrollWorkflow("implementing");

      expect(second.created).toBe(false);
      expect(second.workflowId).toBe(first.workflowId);
    });

    it("maps all v1 states correctly", () => {
      const mappings: [string, string][] = [
        ["planning", "planning"],
        ["implementing", "implementing"],
        ["review_gate", "gating"],
        ["ci_gate", "gating"],
        ["ui_gate", "gating"],
        ["awaiting_pr_link", "awaiting_pr"],
        ["babysitting", "babysitting"],
        ["blocked", "awaiting_manual_fix"],
        ["done", "done"],
        ["stopped", "stopped"],
        ["terminated_pr_closed", "terminated"],
        ["terminated_pr_merged", "terminated"],
      ];

      for (const [v1State, expectedV2Kind] of mappings) {
        expect(mapV1StateToV2Kind(v1State as any)).toBe(expectedV2Kind);
      }
    });

    it("builds correct gate stateJson for v1 gate states", () => {
      const reviewState = buildInitialStateJson("review_gate");
      expect((reviewState.gate as any).kind).toBe("review");

      const ciState = buildInitialStateJson("ci_gate");
      expect((ciState.gate as any).kind).toBe("ci");

      const uiState = buildInitialStateJson("ui_gate");
      expect((uiState.gate as any).kind).toBe("ui");
    });
  });

  describe("daemon ingress adapter", () => {
    it("normalizes daemon completed event to correct signal shape", () => {
      const signal = normalizeDaemonEvent({
        threadId: "t1",
        loopId: "l1",
        runId: "r1",
        status: "completed",
        headSha: "abc123",
        summary: "All tasks done",
      });

      expect(signal.source).toBe("daemon");
      expect(signal.event.kind).toBe("run_completed");
      expect((signal.event as any).result.kind).toBe("success");
      expect((signal.event as any).result.headSha).toBe("abc123");
    });

    it("normalizes daemon failed event to correct signal shape", () => {
      const signal = normalizeDaemonEvent({
        threadId: "t1",
        loopId: "l1",
        runId: "r1",
        status: "failed",
        exitCode: 1,
        errorMessage: "OOM killed",
      });

      expect(signal.source).toBe("daemon");
      expect(signal.event.kind).toBe("run_failed");
      expect((signal.event as any).failure.kind).toBe("runtime_crash");
    });

    it("normalizes daemon progress event", () => {
      const signal = normalizeDaemonEvent({
        threadId: "t1",
        loopId: "l1",
        runId: "r1",
        status: "progress",
        completedTasks: 3,
        totalTasks: 10,
        currentTask: "Fix tests",
      });

      expect(signal.source).toBe("daemon");
      expect(signal.event.kind).toBe("progress_reported");
    });

    it("normalizes partial completion (remaining tasks > 0)", () => {
      const signal = normalizeDaemonEvent({
        threadId: "t1",
        loopId: "l1",
        runId: "r1",
        status: "completed",
        headSha: "abc",
        remainingTasks: 3,
      });

      expect((signal.event as any).result.kind).toBe("partial");
      expect((signal.event as any).result.remainingTasks).toBe(3);
    });
  });

  describe("github ingress adapter", () => {
    it("normalizes CI check completion", () => {
      const signal = normalizeGitHubWebhook({
        action: "check_suite_completed",
        prNumber: 42,
        repoFullName: "org/repo",
        checkConclusion: "success",
        requiredChecks: ["build", "lint"],
        failingChecks: [],
      });

      expect(signal).toBeDefined();
      expect(signal!.source).toBe("github");
      expect(signal!.event.kind).toBe("ci_changed");
      expect((signal!.event as any).result.passed).toBe(true);
    });

    it("normalizes PR review approval", () => {
      const signal = normalizeGitHubWebhook({
        action: "pull_request_review",
        prNumber: 42,
        repoFullName: "org/repo",
        reviewState: "approved",
        unresolvedThreadCount: 0,
        approvalCount: 2,
        requiredApprovals: 1,
      });

      expect(signal).toBeDefined();
      expect(signal!.source).toBe("github");
      expect(signal!.event.kind).toBe("review_changed");
      expect((signal!.event as any).result.passed).toBe(true);
    });

    it("normalizes PR closed/merged", () => {
      const signal = normalizeGitHubWebhook({
        action: "closed",
        prNumber: 42,
        repoFullName: "org/repo",
        merged: true,
      });

      expect(signal!.event.kind).toBe("pr_closed");
      expect((signal!.event as any).merged).toBe(true);
    });

    it("returns null for unrecognized webhook actions", () => {
      const signal = normalizeGitHubWebhook({
        action: "labeled",
        prNumber: 42,
        repoFullName: "org/repo",
      });
      expect(signal).toBeNull();
    });
  });

  describe("ingress → coordinator tick integration", () => {
    it("daemon completed event flows through ingress and triggers state transition", async () => {
      // 1. Enroll workflow in implementing state
      const { workflowId } = await enrollWorkflow("implementing");

      // 2. Simulate daemon completion via ingress adapter
      // handleDaemonIngress writes to signal inbox AND runs a micro-tick
      await injectDaemonEvent(workflowId, {
        threadId: testThreadId,
        loopId: workflowId,
        runId: `run-${nanoid(6)}`,
        status: "completed",
        headSha: "sha-pipeline-test",
        summary: "Implementation complete",
      });

      // 3. Verify state transitioned to gating(review)
      await assertWorkflowState(workflowId, "gating", "review");

      // 4. Verify work items were scheduled (publications only — gates are webhook-driven)
      const items = await getPendingWorkItems(workflowId);
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items.some((w) => w.kind === "publication")).toBe(true);

      // 5. Verify audit events
      const events = await getWorkflowEvents({ db, workflowId });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]!.stateBefore).toBe("implementing");
      expect(events[0]!.stateAfter).toBe("gating");
    });

    it("github review signal → coordinator tick → gate progression", async () => {
      // Start in gating(review)
      const wf = await createWorkflow({
        db,
        threadId: testThreadId,
        generation: 1,
        kind: "gating",
        stateJson: {
          headSha: "sha-test",
          gate: {
            kind: "review",
            status: "waiting",
            runId: null,
            snapshot: {
              requiredApprovals: 1,
              approvalsReceived: 0,
              blockers: [],
            },
          },
        },
      });

      // Inject review passed via GitHub ingress adapter
      await injectGitHubSignal(wf.id, {
        action: "pull_request_review",
        prNumber: 42,
        repoFullName: "org/repo",
        reviewState: "approved",
        unresolvedThreadCount: 0,
        approvalCount: 1,
        requiredApprovals: 1,
      });

      // Tick
      const result = await tick(wf.id);
      expect(result.transitioned).toBe(true);

      // Should advance to gating(ci)
      await assertWorkflowState(wf.id, "gating", "ci");
    });
  });

  describe("work queue — claim and complete", () => {
    it("work items are claimable after coordinator tick schedules them", async () => {
      const { workflowId } = await enrollWorkflow("implementing");

      // Trigger transition via daemon completion
      await injectDaemonEvent(workflowId, {
        threadId: testThreadId,
        loopId: workflowId,
        runId: `run-${nanoid(6)}`,
        status: "completed",
        headSha: "sha-wq-test",
      });

      // Verify work items exist and are pending (publications for gating)
      const items = await getPendingWorkItems(workflowId);
      const pubItem = items.find((w) => w.kind === "publication");
      expect(pubItem).toBeDefined();
      expect(pubItem!.status).toBe("pending");
      expect(pubItem!.workflowId).toBe(workflowId);

      // Verify payload has expected shape
      const payload = pubItem!.payloadJson as Record<string, unknown>;
      expect(payload.workflowState).toBeDefined();

      // Claim and complete it
      const claimToken = `test-claim-${nanoid(6)}`;
      const claimed = await claimNextWorkItem({
        db,
        kind: "publication",
        claimToken,
      });
      expect(claimed).toBeDefined();

      const completed = await completeWorkItem({
        db,
        workItemId: claimed!.id,
        claimToken,
      });
      expect(completed).toBe(true);
    });

    it("publication work items have correct target payloads", async () => {
      const { workflowId } = await enrollWorkflow("implementing");

      await injectDaemonEvent(workflowId, {
        threadId: testThreadId,
        loopId: workflowId,
        runId: `run-${nanoid(6)}`,
        status: "completed",
        headSha: "sha-pub-test",
      });

      const items = await getPendingWorkItems(workflowId);
      const pubItems = items.filter((w) => w.kind === "publication");

      // Should have both status_comment and check_run_summary
      const targets = pubItems.map(
        (w) => ((w.payloadJson as any).target as any).kind,
      );
      expect(targets).toContain("status_comment");
      expect(targets).toContain("check_run_summary");

      // Each should include the new workflow state
      for (const item of pubItems) {
        expect((item.payloadJson as any).workflowState).toBe("gating");
      }
    });
  });

  describe("full lifecycle: implementing → done", () => {
    it("complete lifecycle through all gates", async () => {
      // 1. Enroll in implementing
      const { workflowId } = await enrollWorkflow("implementing");

      // 2. Daemon completes → gating(review)
      await injectDaemonEvent(workflowId, {
        threadId: testThreadId,
        loopId: workflowId,
        runId: `run-impl-${nanoid(4)}`,
        status: "completed",
        headSha: "sha-lifecycle",
        summary: "done",
      });
      await assertWorkflowState(workflowId, "gating", "review");

      // 3. Review passes → gating(ci)
      await injectGitHubSignal(workflowId, {
        action: "pull_request_review",
        prNumber: 1,
        repoFullName: "org/repo",
        reviewState: "approved",
        unresolvedThreadCount: 0,
        approvalCount: 1,
        requiredApprovals: 1,
      });
      await tick(workflowId);
      await assertWorkflowState(workflowId, "gating", "ci");

      // 4. CI passes → gating(ui)
      await injectGitHubSignal(workflowId, {
        action: "check_suite_completed",
        prNumber: 1,
        repoFullName: "org/repo",
        checkConclusion: "success",
        requiredChecks: ["build"],
        failingChecks: [],
      });
      await tick(workflowId);
      await assertWorkflowState(workflowId, "gating", "ui");

      // 5. UI bypass → awaiting_pr
      await appendSignalToInbox({
        db,
        loopId: workflowId,
        causeType: "human_bypass",
        payload: {
          source: "human",
          event: {
            kind: "bypass_requested",
            actorUserId: testUserId,
            target: "ui",
          },
        },
      });
      await tick(workflowId);
      await assertWorkflowState(workflowId, "awaiting_pr");

      // 6. Verify event trail covers the full journey
      const events = await getWorkflowEvents({ db, workflowId });
      const stateTrail = events.map((e) => `${e.stateBefore}→${e.stateAfter}`);
      expect(stateTrail).toContain("implementing→gating");
      expect(stateTrail.filter((s) => s === "gating→gating").length).toBe(2);

      // 7. Verify runtime status reflects latest state
      const status = await getRuntimeStatus({ db, workflowId });
      expect(status).toBeDefined();
    });

    it("fix cycle: review blocked → re-implement → pass", async () => {
      const { workflowId } = await enrollWorkflow("implementing");

      // Impl completes → gating(review)
      await injectDaemonEvent(workflowId, {
        threadId: testThreadId,
        loopId: workflowId,
        runId: `run-fix-${nanoid(4)}`,
        status: "completed",
        headSha: "sha-fix-1",
      });
      await assertWorkflowState(workflowId, "gating", "review");

      // Review blocked → back to implementing
      await injectGitHubSignal(workflowId, {
        action: "pull_request_review",
        prNumber: 1,
        repoFullName: "org/repo",
        reviewState: "changes_requested",
        unresolvedThreadCount: 3,
        approvalCount: 0,
        requiredApprovals: 1,
      });
      await tick(workflowId);
      await assertWorkflowState(workflowId, "implementing");

      // Check fixAttemptCount incremented
      const row = await getWorkflow({ db, workflowId });
      expect(row!.fixAttemptCount).toBe(1);

      // Re-implement succeeds → gating(review) again
      await injectDaemonEvent(workflowId, {
        threadId: testThreadId,
        loopId: workflowId,
        runId: `run-fix2-${nanoid(4)}`,
        status: "completed",
        headSha: "sha-fix-2",
      });
      await assertWorkflowState(workflowId, "gating", "review");

      // fixAttemptCount reset after successful implementation
      const row2 = await getWorkflow({ db, workflowId });
      expect(row2!.fixAttemptCount).toBe(0);
    });

    it("daemon failure with budget exhaustion → awaiting_manual_fix", async () => {
      // Create workflow with low fix budget
      const wf = await createWorkflow({
        db,
        threadId: testThreadId,
        generation: 1,
        kind: "implementing",
        stateJson: {
          planVersion: 1,
          dispatch: {
            kind: "queued",
            dispatchId: "d-budget",
            executionClass: "implementation_runtime",
          },
        },
        maxFixAttempts: 2,
      });

      // Complete → gating → block → implementing (fixAttemptCount=1)
      await injectDaemonEvent(wf.id, {
        threadId: testThreadId,
        loopId: wf.id,
        runId: `run-b1-${nanoid(4)}`,
        status: "completed",
        headSha: "sha-b1",
      });
      await assertWorkflowState(wf.id, "gating", "review");

      await injectGitHubSignal(wf.id, {
        action: "pull_request_review",
        prNumber: 1,
        repoFullName: "org/repo",
        reviewState: "changes_requested",
        unresolvedThreadCount: 1,
        approvalCount: 0,
        requiredApprovals: 1,
      });
      await tick(wf.id);
      await assertWorkflowState(wf.id, "implementing");

      // Daemon fails with fixAttemptCount=1 >= maxFixAttempts-1=1 → budget exhausted
      // Note: failed events don't trigger self-dispatch (only completed events do),
      // so we need an explicit tick after the ingress writes the signal.
      await injectDaemonEvent(wf.id, {
        threadId: testThreadId,
        loopId: wf.id,
        runId: `run-b2-${nanoid(4)}`,
        status: "failed",
        exitCode: 1,
        errorMessage: "OOM",
      });
      await tick(wf.id);

      await assertWorkflowState(wf.id, "awaiting_manual_fix");
    });

    it("human stop terminates from any active state", async () => {
      const { workflowId } = await enrollWorkflow("implementing");

      await appendSignalToInbox({
        db,
        loopId: workflowId,
        causeType: "human_stop",
        payload: {
          source: "human",
          event: { kind: "stop_requested", actorUserId: testUserId },
        },
      });
      await tick(workflowId);

      await assertWorkflowState(workflowId, "stopped");

      // Terminal state: further signals should noop
      await appendSignalToInbox({
        db,
        loopId: workflowId,
        causeType: "daemon_run_completed",
        payload: {
          source: "daemon",
          event: {
            kind: "run_completed",
            runId: "r-post-stop",
            result: { kind: "success", headSha: "x", summary: "y" },
          },
        },
      });
      const result = await tick(workflowId);
      expect(result.transitioned).toBe(false);
    });
  });

  describe("runtime status tracking", () => {
    it("runtime status updates through transitions", async () => {
      const { workflowId } = await enrollWorkflow("implementing");

      // Before any signals — noop tick should still create runtime status
      await tick(workflowId);
      let status = await getRuntimeStatus({ db, workflowId });
      expect(status).toBeDefined();
      expect(status!.state).toBe("implementing");

      // After transition to gating
      await injectDaemonEvent(workflowId, {
        threadId: testThreadId,
        loopId: workflowId,
        runId: `run-status-${nanoid(4)}`,
        status: "completed",
        headSha: "sha-status",
      });

      status = await getRuntimeStatus({ db, workflowId });
      expect(status!.state).toBe("gating");
      expect(status!.gate).toBe("review");
    });
  });

  describe("self-dispatch circuit breaker", () => {
    it("daemon ingress returns null selfDispatch on completed event (payload construction not yet wired)", async () => {
      const { workflowId } = await enrollWorkflow("implementing");

      const response = await handleDaemonIngress({
        db,
        rawEvent: {
          threadId: testThreadId,
          loopId: workflowId,
          runId: `run-sd-${nanoid(4)}`,
          status: "completed",
          headSha: "sha-sd",
          summary: "done",
        },
        workflowId:
          workflowId as import("@terragon/shared/delivery-loop/domain/workflow").WorkflowId,
        consecutiveDispatches: 0,
      });

      // Self-dispatch payload construction is not yet wired — returns null
      // until a real SdlcSelfDispatchPayload can be built from dispatch state
      expect(response.selfDispatch).toBeNull();
    });

    it("daemon ingress returns null selfDispatch at circuit breaker limit", async () => {
      const { workflowId } = await enrollWorkflow("implementing");

      const response = await handleDaemonIngress({
        db,
        rawEvent: {
          threadId: testThreadId,
          loopId: workflowId,
          runId: `run-cb-${nanoid(4)}`,
          status: "completed",
          headSha: "sha-cb",
        },
        workflowId:
          workflowId as import("@terragon/shared/delivery-loop/domain/workflow").WorkflowId,
        consecutiveDispatches: 7, // at the MAX_CONSECUTIVE_SELF_DISPATCHES limit
      });

      expect(response.selfDispatch).toBeNull();
    });

    it("daemon ingress returns null selfDispatch for failed events", async () => {
      const { workflowId } = await enrollWorkflow("implementing");

      const response = await handleDaemonIngress({
        db,
        rawEvent: {
          threadId: testThreadId,
          loopId: workflowId,
          runId: `run-fail-${nanoid(4)}`,
          status: "failed",
          exitCode: 1,
          errorMessage: "crash",
        },
        workflowId:
          workflowId as import("@terragon/shared/delivery-loop/domain/workflow").WorkflowId,
      });

      expect(response.selfDispatch).toBeNull();
    });
  });

  describe("signal format compatibility", () => {
    it("daemon ingress signals are consumable by coordinator tick", async () => {
      // This is the critical seam test: daemon-ingress normalizes events into
      // a specific signal format → appended to inbox → coordinator tick must
      // be able to parse and reduce them.
      const wf = await createWorkflow({
        db,
        threadId: testThreadId,
        generation: 1,
        kind: "implementing",
        stateJson: {
          planVersion: 1,
          dispatch: {
            kind: "queued",
            dispatchId: "d-compat",
            executionClass: "implementation_runtime",
          },
        },
      });

      // Use raw ingress path (not tick.test.ts helpers)
      const signal = normalizeDaemonEvent({
        threadId: testThreadId,
        loopId: wf.id,
        runId: "run-compat",
        status: "completed",
        headSha: "sha-compat",
        summary: "done",
      });

      await appendSignalToInbox({
        db,
        loopId: wf.id,
        causeType: "daemon_run_completed",
        payload: signal as Record<string, unknown>,
      });

      const result = await tick(wf.id);
      expect(result.signalsProcessed).toBe(1);
      expect(result.transitioned).toBe(true);
      expect(result.stateAfter).toBe("gating");
    });

    it("github ingress signals are consumable by coordinator tick", async () => {
      const wf = await createWorkflow({
        db,
        threadId: testThreadId,
        generation: 1,
        kind: "gating",
        stateJson: {
          headSha: "sha-compat-gh",
          gate: {
            kind: "review",
            status: "waiting",
            runId: null,
            snapshot: {
              requiredApprovals: 1,
              approvalsReceived: 0,
              blockers: [],
            },
          },
        },
      });

      // Use raw GitHub ingress normalization
      const signal = normalizeGitHubWebhook({
        action: "pull_request_review",
        prNumber: 1,
        repoFullName: "org/repo",
        reviewState: "approved",
        unresolvedThreadCount: 0,
        approvalCount: 1,
        requiredApprovals: 1,
      });

      await appendSignalToInbox({
        db,
        loopId: wf.id,
        causeType: "github_review_changed",
        payload: signal as Record<string, unknown>,
      });

      const result = await tick(wf.id);
      expect(result.signalsProcessed).toBe(1);
      expect(result.transitioned).toBe(true);
      // review passed → gating(ci)
      await assertWorkflowState(wf.id, "gating", "ci");
    });
  });

  describe("planning → implementing transition", () => {
    it("planning → implementing transition creates dispatch work item after plan_approved", async () => {
      // 1. Enroll workflow in planning state
      const { workflowId } = await enrollWorkflow("planning", "planning");

      // 2. Simulate daemon completing its planning run
      await appendSignalToInbox({
        db,
        loopId: workflowId,
        causeType: "daemon_run_completed",
        payload: {
          source: "daemon",
          event: {
            kind: "run_completed",
            runId: `run-${nanoid(6)}`,
            result: {
              kind: "success",
              headSha: null,
              summary: "Plan generated",
            },
          },
        },
      });

      // 3. Tick — run_completed during planning returns null, so no transition
      const tickResult1 = await tick(workflowId);
      expect(tickResult1.transitioned).toBe(false);
      await assertWorkflowState(workflowId, "planning");

      // 4. Simulate checkpoint pipeline's plan approval (what promote-plan.ts writes)
      await appendSignalToInbox({
        db,
        loopId: workflowId,
        causeType: "human_resume",
        payload: {
          source: "human",
          event: {
            kind: "plan_approved",
            artifactId: `art-${nanoid(6)}`,
          },
        },
      });

      // 5. Tick — plan_approved should transition to implementing
      const tickResult2 = await tick(workflowId);
      expect(tickResult2.transitioned).toBe(true);
      await assertWorkflowState(workflowId, "implementing");

      // 6. Assert dispatch work item was created with implementation_runtime
      const items = await getPendingWorkItems(workflowId);
      const dispatchItem = items.find((w) => w.kind === "dispatch");
      expect(dispatchItem).toBeDefined();
      expect((dispatchItem!.payloadJson as any).executionClass).toBe(
        "implementation_runtime",
      );
    });

    it("run_completed during planning does NOT advance to implementing", async () => {
      // 1. Enroll workflow in planning
      const { workflowId } = await enrollWorkflow("planning", "planning");

      // 2. Inject run_completed daemon signal
      await appendSignalToInbox({
        db,
        loopId: workflowId,
        causeType: "daemon_run_completed",
        payload: {
          source: "daemon",
          event: {
            kind: "run_completed",
            runId: `run-${nanoid(6)}`,
            result: { kind: "success", headSha: null, summary: "Plan done" },
          },
        },
      });

      // 3. Tick
      const result = await tick(workflowId);

      // 4. Assert still in planning
      expect(result.transitioned).toBe(false);
      await assertWorkflowState(workflowId, "planning");

      // 5. Assert NO dispatch work items were created
      const items = await getPendingWorkItems(workflowId);
      const dispatchItems = items.filter((w) => w.kind === "dispatch");
      expect(dispatchItems.length).toBe(0);
    });
  });

  describe("babysit signal handling", () => {
    it("babysit_recheck_blocked signal is processed and transitions to implementing", async () => {
      // 1. Create workflow directly in babysitting state
      const wf = await createWorkflow({
        db,
        threadId: testThreadId,
        generation: 1,
        kind: "babysitting",
        stateJson: {
          headSha: "abc123",
          nextCheckAt: new Date().toISOString(),
        },
      });

      // 2. Inject babysit_gates_blocked signal
      await appendSignalToInbox({
        db,
        loopId: wf.id,
        causeType: "babysit_recheck_blocked",
        payload: {
          source: "babysit",
          event: {
            kind: "babysit_gates_blocked",
            headSha: "abc123",
          },
        },
      });

      // 3. Tick
      const result = await tick(wf.id);

      // 4. Assert signal was processed
      expect(result.signalsProcessed).toBeGreaterThan(0);

      // 5. Assert workflow transitioned to implementing (babysit_blocked → retryToImplementing)
      await assertWorkflowState(wf.id, "implementing");
    });
  });

  describe("concurrent workflow isolation", () => {
    it("signals for one workflow do not affect another", async () => {
      // Create two threads, each with its own workflow
      const { threadId: threadId2 } = await createTestThread({
        db,
        userId: testUserId,
      });

      const wf1 = await createWorkflow({
        db,
        threadId: testThreadId,
        generation: 1,
        kind: "implementing",
        stateJson: {
          planVersion: 1,
          dispatch: {
            kind: "queued",
            dispatchId: "d-iso-1",
            executionClass: "implementation_runtime",
          },
        },
      });

      const wf2 = await createWorkflow({
        db,
        threadId: threadId2,
        generation: 1,
        kind: "implementing",
        stateJson: {
          planVersion: 1,
          dispatch: {
            kind: "queued",
            dispatchId: "d-iso-2",
            executionClass: "implementation_runtime",
          },
        },
      });

      // Signal only wf1
      await appendSignalToInbox({
        db,
        loopId: wf1.id,
        causeType: "daemon_run_completed",
        payload: {
          source: "daemon",
          event: {
            kind: "run_completed",
            runId: "r-iso",
            result: { kind: "success", headSha: "sha-iso", summary: "done" },
          },
        },
      });

      await tick(wf1.id);
      await tick(wf2.id);

      // wf1 should have transitioned; wf2 should not
      await assertWorkflowState(wf1.id, "gating", "review");
      await assertWorkflowState(wf2.id, "implementing");
    });
  });
});
