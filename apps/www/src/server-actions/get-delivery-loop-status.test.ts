import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  buildDeliveryLoopTopProgressPhases,
  buildDeliveryLoopStatusChecks,
  buildSnapshotFromV3Head,
  getDeliveryLoopSnapshotStateSummary,
} from "@/lib/delivery-loop-status";
import { unwrapResult } from "@/lib/server-actions";
import { getDeliveryLoopStatusAction } from "./get-delivery-loop-status";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { mockLoggedInUser, mockLoggedOutUser } from "@/test-helpers/mock-next";
import {
  createPlanArtifact,
  createImplementationArtifact,
  replacePlanTasksForArtifact,
  markPlanTasksCompletedByAgent,
} from "@terragon/shared/delivery-loop/store/artifact-store";
import { createWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import { ensureWorkflowHead } from "@/server-lib/delivery-loop/v3/store";
import type { WorkflowHead } from "@/server-lib/delivery-loop/v3/types";
import * as schema from "@terragon/shared/db/schema";
import { and, eq } from "drizzle-orm";

async function getDeliveryLoopStatus(threadId: string) {
  return unwrapResult(await getDeliveryLoopStatusAction(threadId));
}

const TERMINAL_STATUS_CASES = [
  {
    blockedReason: "PR merged via squash",
    expectedState: "terminated_pr_merged",
    expectedLabel: "Terminated: PR Merged",
    expectedSummaryExplanation:
      "The loop ended because the pull request was merged.",
  },
  {
    blockedReason: "PR closed",
    expectedState: "terminated_pr_closed",
    expectedLabel: "Terminated: PR Closed",
    expectedSummaryExplanation:
      "The loop ended because the pull request was closed.",
  },
] as const;

describe("getDeliveryLoopStatusAction", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the v3 head to resolve an active loop even when the legacy row is terminal", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    await mockLoggedInUser(session);

    const workflow = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "terminated",
      stateJson: {},
      userId: user.id,
      repoFullName: "owner/repo",
    });
    await ensureWorkflowHead({ db, workflowId: workflow.id });
    await db
      .update(schema.deliveryWorkflowHeadV3)
      .set({
        state: "implementing",
        blockedReason: null,
        updatedAt: new Date("2026-03-18T00:00:00.000Z"),
        lastActivityAt: new Date("2026-03-18T00:00:00.000Z"),
      })
      .where(eq(schema.deliveryWorkflowHeadV3.workflowId, workflow.id));

    const status = await getDeliveryLoopStatus(threadId);

    expect(status).not.toBeNull();
    expect(status?.loopId).toBe(workflow.id);
    expect(status?.state).toBe("implementing");
    expect(status?.actions.canApprovePlan).toBe(false);
  });

  it.each(TERMINAL_STATUS_CASES)(
    "projects terminated workflow heads consistently for $blockedReason",
    ({
      blockedReason,
      expectedState,
      expectedLabel,
      expectedSummaryExplanation,
    }) => {
      const head: WorkflowHead = {
        workflowId: "wf-terminal",
        threadId: "thread-terminal",
        generation: 1,
        version: 3,
        state: "terminated",
        activeGate: null,
        headSha: null,
        activeRunId: null,
        activeRunSeq: null,
        leaseExpiresAt: null,
        lastTerminalRunSeq: null,
        fixAttemptCount: 0,
        infraRetryCount: 0,
        maxFixAttempts: 6,
        maxInfraRetries: 10,
        blockedReason,
        createdAt: new Date("2026-03-18T00:00:00.000Z"),
        updatedAt: new Date("2026-03-18T00:00:00.000Z"),
        lastActivityAt: new Date("2026-03-18T00:00:00.000Z"),
      };

      const snapshot = buildSnapshotFromV3Head(head);
      const summary = getDeliveryLoopSnapshotStateSummary(snapshot);

      expect(snapshot.kind).toBe(expectedState);
      expect(summary.stateLabel).toBe(expectedLabel);
      expect(summary.explanation).toBe(expectedSummaryExplanation);
      expect(summary.progressPercent).toBe(100);
    },
  );

  it("surfaces blocked summary from the canonical snapshot model", () => {
    const summary = getDeliveryLoopSnapshotStateSummary({
      kind: "blocked",
      from: "review_gate",
      reason: "gate_failure",
      selectedAgent: "codex",
      dispatchStatus: "failed",
      dispatchAttemptCount: 1,
      activeRunId: "run_123",
      activeGateRunId: "gate_123",
      lastFailureCategory: "gate_failed",
    });

    expect(summary).toEqual({
      stateLabel: "Blocked in Review Gate",
      explanation:
        "A review gate is blocked and needs intervention before the loop can continue.",
      progressPercent: 45,
    });
  });

  it("derives fallback gate statuses from blocked origin instead of generic blocked state", () => {
    const checks = buildDeliveryLoopStatusChecks({
      loopSnapshot: {
        kind: "blocked",
        from: "review_gate",
        reason: "gate_failure",
        selectedAgent: "codex",
        dispatchStatus: "failed",
        dispatchAttemptCount: 1,
        activeRunId: "run_123",
        activeGateRunId: "gate_123",
        lastFailureCategory: "gate_failed",
      },
      currentHeadSha: "sha-1",
      ciRun: null,
      reviewThreadRun: null,
      deepReviewRun: null,
      carmackReviewRun: null,
      unresolvedDeepFindingCount: 0,
      unresolvedCarmackFindingCount: 0,
      videoCaptureStatus: "not_started",
      videoFailureMessage: null,
    });

    expect(checks).toEqual([
      expect.objectContaining({ key: "ci", status: "not_started" }),
      expect.objectContaining({ key: "review_threads", status: "not_started" }),
      expect.objectContaining({ key: "deep_review", status: "pending" }),
      expect.objectContaining({
        key: "architecture_carmack",
        status: "pending",
      }),
      expect.objectContaining({ key: "video", status: "pending" }),
    ]);
  });

  it("builds top progress phases from the canonical snapshot instead of raw blocked state", () => {
    const loopSnapshot = {
      kind: "blocked",
      from: "review_gate",
      reason: "gate_failure",
      selectedAgent: "codex",
      dispatchStatus: "failed",
      dispatchAttemptCount: 1,
      activeRunId: "run_123",
      activeGateRunId: "gate_123",
      lastFailureCategory: "gate_failed",
    } as const;

    const checks = buildDeliveryLoopStatusChecks({
      loopSnapshot,
      currentHeadSha: "sha-1",
      ciRun: null,
      reviewThreadRun: null,
      deepReviewRun: null,
      carmackReviewRun: null,
      unresolvedDeepFindingCount: 0,
      unresolvedCarmackFindingCount: 0,
      videoCaptureStatus: "not_started",
      videoFailureMessage: null,
    });

    expect(
      buildDeliveryLoopTopProgressPhases({
        loopSnapshot,
        checks,
      }),
    ).toEqual([
      expect.objectContaining({ key: "planning", status: "passed" }),
      expect.objectContaining({ key: "implementing", status: "passed" }),
      expect.objectContaining({ key: "reviewing", status: "pending" }),
      expect.objectContaining({ key: "ci", status: "not_started" }),
      expect.objectContaining({ key: "ui_testing", status: "not_started" }),
    ]);
  });

  it("returns artifact readiness and planned task summary", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    await mockLoggedInUser(session);

    const workflow = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "implementing",
      stateJson: {},
      userId: user.id,
      repoFullName: "owner/repo",
      currentHeadSha: "sha-status-1",
    });
    await ensureWorkflowHead({ db, workflowId: workflow.id });

    const planArtifact = await createPlanArtifact({
      db,
      loopId: workflow.id,
      loopVersion: 1,
      status: "accepted",
      generatedBy: "agent",
      payload: {
        planText: "Status test plan",
        source: "agent_text",
        tasks: [
          {
            stableTaskId: "task-1",
            title: "Implement artifacts",
            acceptance: ["Artifacts persisted"],
          },
          {
            stableTaskId: "task-2",
            title: "Add gates",
            acceptance: ["Gates enforced"],
          },
        ],
      },
    });
    await replacePlanTasksForArtifact({
      db,
      loopId: workflow.id,
      artifactId: planArtifact.id,
      tasks: [
        {
          stableTaskId: "task-1",
          title: "Implement artifacts",
          acceptance: ["Artifacts persisted"],
        },
        {
          stableTaskId: "task-2",
          title: "Add gates",
          acceptance: ["Gates enforced"],
        },
      ],
    });
    await markPlanTasksCompletedByAgent({
      db,
      loopId: workflow.id,
      artifactId: planArtifact.id,
      completions: [
        {
          stableTaskId: "task-1",
          status: "done",
          evidence: {
            headSha: "sha-status-1",
            changedFiles: ["packages/shared/src/model/sdlc-loop.ts"],
            note: "completed task 1",
          },
        },
      ],
    });

    await createImplementationArtifact({
      db,
      loopId: workflow.id,
      headSha: "sha-status-1",
      loopVersion: 2,
      status: "accepted",
      generatedBy: "system",
      payload: {
        headSha: "sha-status-1",
        summary: "Implementation snapshot",
        changedFiles: ["apps/www/src/server-lib/checkpoint-thread-internal.ts"],
        completedTaskIds: ["task-1"],
      },
    });

    const status = await getDeliveryLoopStatus(threadId);
    expect(status).not.toBeNull();
    expect(status?.loopId).toBe(workflow.id);
    expect(status?.links.pullRequestUrl).toBeNull();
    expect(status?.artifacts.planningArtifact?.id).toBe(planArtifact.id);
    expect(status?.artifacts.planningArtifact?.status).toBe("accepted");
    expect(status?.artifacts.planningArtifact?.planText).toBe(
      "Status test plan",
    );
    expect(status?.artifacts.implementationArtifact?.headSha).toBe(
      "sha-status-1",
    );
    expect(status?.artifacts.plannedTasks[0]?.acceptance).toEqual([
      "Artifacts persisted",
    ]);
    expect(status?.artifacts.plannedTaskSummary).toEqual({
      total: 2,
      done: 1,
      remaining: 1,
    });
  });

  it("surfaces awaiting_manual_fix as blocked in implementing attention", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    await mockLoggedInUser(session);

    const loopBlocked = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "awaiting_manual_fix",
      stateJson: {},
      userId: user.id,
      repoFullName: "owner/repo",
      currentHeadSha: "sha-blocked-1",
    });
    await ensureWorkflowHead({ db, workflowId: loopBlocked.id });

    const status = await getDeliveryLoopStatus(threadId);

    expect(status?.state).toBe("blocked");
    expect(status?.actions.canBypassOnce).toBe(false);
    expect(status?.needsAttention.topBlockers).toContainEqual(
      expect.objectContaining({
        source: "human_feedback",
      }),
    );
  });

  it("returns null when no loop exists for the thread", async () => {
    const { session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: session.userId,
    });
    await mockLoggedInUser(session);

    const status = await getDeliveryLoopStatus(threadId);
    expect(status).toBeNull();
  });

  it("rejects unauthorized users", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
    });
    await mockLoggedOutUser();

    await expect(getDeliveryLoopStatus(threadId)).rejects.toThrow(
      "Unauthorized",
    );
  });

  it("exposes latest planning artifact for a v2 workflow", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    await mockLoggedInUser(session);

    const workflow = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "implementing",
      stateJson: {},
      userId: user.id,
      repoFullName: "owner/repo",
    });
    await ensureWorkflowHead({ db, workflowId: workflow.id });
    const planArtifact = await createPlanArtifact({
      db,
      loopId: workflow.id,
      loopVersion: 1,
      status: "accepted",
      generatedBy: "agent",
      payload: {
        planText: "Fallback plan",
        source: "agent_text",
        tasks: [
          {
            stableTaskId: "task-1",
            title: "Fallback task",
            acceptance: [],
          },
        ],
      },
    });
    await replacePlanTasksForArtifact({
      db,
      loopId: workflow.id,
      artifactId: planArtifact.id,
      tasks: [
        {
          stableTaskId: "task-1",
          title: "Fallback task",
          acceptance: [],
        },
      ],
    });

    const status = await getDeliveryLoopStatus(threadId);
    expect(status?.artifacts.planningArtifact?.id).toBe(planArtifact.id);

    const persistedTasks = await db.query.deliveryPlanTask.findMany({
      where: and(
        eq(schema.deliveryPlanTask.loopId, workflow.id),
        eq(schema.deliveryPlanTask.artifactId, planArtifact.id),
      ),
    });
    expect(persistedTasks).toHaveLength(1);
  });
});
