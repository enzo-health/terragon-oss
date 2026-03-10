import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  buildDeliveryLoopTopProgressPhases,
  buildSdlcLoopStatusChecks,
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
  createImplementationArtifactForHead,
  createPlanArtifactForLoop,
  enrollSdlcLoopForThread,
  markPlanTasksCompletedByAgent,
  replacePlanTasksForArtifact,
} from "@terragon/shared/model/delivery-loop";
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
    const checks = buildSdlcLoopStatusChecks({
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

    const checks = buildSdlcLoopStatusChecks({
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

    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
      currentHeadSha: "sha-status-1",
    });
    expect(loop).toBeDefined();

    const planArtifact = await createPlanArtifactForLoop({
      db,
      loopId: loop!.id,
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
      loopId: loop!.id,
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
      loopId: loop!.id,
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

    await createImplementationArtifactForHead({
      db,
      loopId: loop!.id,
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
    expect(status?.loopId).toBe(loop!.id);
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

  it("uses persisted blocked origin to describe blocked implementation attention", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    await mockLoggedInUser(session);

    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
      currentHeadSha: "sha-blocked-1",
    });

    await db
      .update(schema.sdlcLoop)
      .set({
        state: "blocked",
        blockedFromState: "implementing",
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const status = await getDeliveryLoopStatus(threadId);

    expect(status?.state).toBe("blocked");
    expect(status?.stateLabel).toBe("Blocked in Implementing");
    expect(status?.needsAttention.topBlockers).toContainEqual(
      expect.objectContaining({
        title: "Implementation is blocked and needs human feedback",
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

  it("exposes latest planning artifact when active pointer is null", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    await mockLoggedInUser(session);

    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });
    const planArtifact = await createPlanArtifactForLoop({
      db,
      loopId: loop!.id,
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
      loopId: loop!.id,
      artifactId: planArtifact.id,
      tasks: [
        {
          stableTaskId: "task-1",
          title: "Fallback task",
          acceptance: [],
        },
      ],
    });

    await db
      .update(schema.sdlcLoop)
      .set({ activePlanArtifactId: null })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const status = await getDeliveryLoopStatus(threadId);
    expect(status?.artifacts.planningArtifact?.id).toBe(planArtifact.id);

    const persistedTasks = await db.query.sdlcPlanTask.findMany({
      where: and(
        eq(schema.sdlcPlanTask.loopId, loop!.id),
        eq(schema.sdlcPlanTask.artifactId, planArtifact.id),
      ),
    });
    expect(persistedTasks).toHaveLength(1);
  });
});
