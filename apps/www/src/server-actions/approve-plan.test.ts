import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { unwrapResult } from "@/lib/server-actions";
import { approvePlan as approvePlanAction } from "./approve-plan";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { mockLoggedInUser } from "@/test-helpers/mock-next";
import { updateThreadChat } from "@terragon/shared/model/threads";
import {
  enrollSdlcLoopForThread,
  getActiveSdlcLoopForThread,
} from "@terragon/shared/model/sdlc-loop";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import * as schema from "@terragon/shared/db/schema";
import { and, eq } from "drizzle-orm";

vi.mock("@/server-lib/follow-up", () => ({
  queueFollowUpInternal: vi.fn(),
}));

vi.mock("@/lib/subscription", () => ({
  getAccessInfoForUser: vi.fn(async () => ({ tier: "core" })),
}));

async function approvePlan({
  threadId,
  threadChatId,
}: {
  threadId: string;
  threadChatId: string;
}) {
  return unwrapResult(await approvePlanAction({ threadId, threadChatId }));
}

describe("approvePlan", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it("creates plan artifact/tasks and transitions planning->implementing from ExitPlanMode payload", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
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
    expect(loop).toBeDefined();

    await updateThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
      updates: {
        appendMessages: [
          {
            type: "tool-call",
            id: "exit-plan-1",
            name: "ExitPlanMode",
            parent_tool_use_id: null,
            parameters: {
              plan: JSON.stringify({
                planText: "Implement artifact-gated SDLC flow",
                tasks: [
                  {
                    stableTaskId: "task-1",
                    title: "Create artifacts",
                    acceptance: ["Artifacts persisted"],
                  },
                  {
                    stableTaskId: "task-2",
                    title: "Gate transitions",
                    acceptance: ["Transitions enforce artifacts"],
                  },
                ],
              }),
            },
          },
        ],
      },
    });

    await approvePlan({ threadId, threadChatId });

    expect(queueFollowUpInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        threadId,
        threadChatId,
      }),
    );

    const activeLoop = await getActiveSdlcLoopForThread({
      db,
      userId: user.id,
      threadId,
    });
    expect(activeLoop?.state).toBe("implementing");
    expect(activeLoop?.activePlanArtifactId).toBeTruthy();

    const planArtifacts = await db.query.sdlcPhaseArtifact.findMany({
      where: and(
        eq(schema.sdlcPhaseArtifact.loopId, loop!.id),
        eq(schema.sdlcPhaseArtifact.phase, "planning"),
      ),
    });
    expect(planArtifacts).toHaveLength(1);
    expect(planArtifacts[0]?.status).toBe("accepted");

    const planTasks = await db.query.sdlcPlanTask.findMany({
      where: and(
        eq(schema.sdlcPlanTask.loopId, loop!.id),
        eq(schema.sdlcPlanTask.artifactId, planArtifacts[0]!.id),
      ),
    });
    expect(planTasks).toHaveLength(2);
    expect(planTasks.every((task) => task.status === "todo")).toBe(true);
  });

  it("supports Write->ExitPlanMode plan artifacts and human_required policy", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
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
      planApprovalPolicy: "human_required",
    });
    expect(loop?.planApprovalPolicy).toBe("human_required");

    await updateThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
      updates: {
        appendMessages: [
          {
            type: "tool-call",
            id: "write-plan-1",
            name: "Write",
            parent_tool_use_id: null,
            parameters: {
              file_path: "plans/sdlc-plan.md",
              content: JSON.stringify({
                planText: "Plan from Write tool",
                tasks: [
                  {
                    stableTaskId: "task-1",
                    title: "Task one",
                    acceptance: ["Done"],
                  },
                ],
              }),
            },
          },
          {
            type: "tool-call",
            id: "exit-plan-2",
            name: "ExitPlanMode",
            parent_tool_use_id: null,
            parameters: {},
          },
        ],
      },
    });

    await approvePlan({ threadId, threadChatId });

    const activeLoop = await getActiveSdlcLoopForThread({
      db,
      userId: user.id,
      threadId,
    });
    expect(activeLoop?.state).toBe("implementing");

    const artifact = await db.query.sdlcPhaseArtifact.findFirst({
      where: and(
        eq(schema.sdlcPhaseArtifact.loopId, loop!.id),
        eq(schema.sdlcPhaseArtifact.phase, "planning"),
      ),
      orderBy: [schema.sdlcPhaseArtifact.createdAt],
    });
    expect(artifact?.status).toBe("approved");
    expect(artifact?.approvedByUserId).toBe(user.id);
  });

  it("rejects approval when no plan artifact exists in thread chat", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
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
    expect(loop).toBeDefined();
    expect(loop?.state).toBe("planning");

    await expect(approvePlan({ threadId, threadChatId })).rejects.toThrow(
      "No plan artifact found",
    );
  });

  it("rejects approval when loop is not in planning", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
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
    await db
      .update(schema.sdlcLoop)
      .set({ state: "implementing" })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    await expect(approvePlan({ threadId, threadChatId })).rejects.toThrow(
      "planning phase",
    );
  });
});
