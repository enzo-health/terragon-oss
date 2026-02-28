import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { unwrapResult } from "@/lib/server-actions";
import { getSdlcLoopStatusAction } from "./get-sdlc-loop-status";
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
} from "@terragon/shared/model/sdlc-loop";
import * as schema from "@terragon/shared/db/schema";
import { and, eq } from "drizzle-orm";

async function getSdlcLoopStatus(threadId: string) {
  return unwrapResult(await getSdlcLoopStatusAction(threadId));
}

describe("getSdlcLoopStatusAction", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
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

    const status = await getSdlcLoopStatus(threadId);
    expect(status).not.toBeNull();
    expect(status?.loopId).toBe(loop!.id);
    expect(status?.links.pullRequestUrl).toBeNull();
    expect(status?.artifacts.planningArtifact?.id).toBe(planArtifact.id);
    expect(status?.artifacts.planningArtifact?.status).toBe("accepted");
    expect(status?.artifacts.implementationArtifact?.headSha).toBe(
      "sha-status-1",
    );
    expect(status?.artifacts.plannedTaskSummary).toEqual({
      total: 2,
      done: 1,
      remaining: 1,
    });
  });

  it("returns null when no loop exists for the thread", async () => {
    const { session } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: session.userId,
    });
    await mockLoggedInUser(session);

    const status = await getSdlcLoopStatus(threadId);
    expect(status).toBeNull();
  });

  it("rejects unauthorized users", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
    });
    await mockLoggedOutUser();

    await expect(getSdlcLoopStatus(threadId)).rejects.toThrow("Unauthorized");
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

    const status = await getSdlcLoopStatus(threadId);
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
