import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  buildDeliveryLoopTopProgressPhases,
  buildDeliveryLoopStatusChecks,
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
import * as schema from "@terragon/shared/db/schema";
import { and, eq } from "drizzle-orm";

async function getDeliveryLoopStatus(threadId: string) {
  return unwrapResult(await getDeliveryLoopStatusAction(threadId));
}

describe("getDeliveryLoopStatusAction", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

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

    await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "awaiting_manual_fix",
      stateJson: {},
      userId: user.id,
      repoFullName: "owner/repo",
      currentHeadSha: "sha-blocked-1",
    });

    const status = await getDeliveryLoopStatus(threadId);

    expect(status?.state).toBe("blocked");
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
