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
  createPlanArtifact,
  replacePlanTasksForArtifact,
} from "@terragon/shared/delivery-loop/store/artifact-store";
import {
  createWorkflow,
  getActiveWorkflowForThread,
} from "@terragon/shared/delivery-loop/store/workflow-store";
import { ensureWorkflowHead } from "@/server-lib/delivery-loop/v3/store";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import * as schema from "@terragon/shared/db/schema";
import { and, eq } from "drizzle-orm";

const approvePlanArtifactMock = vi.hoisted(() => vi.fn());

vi.mock(
  "@terragon/shared/delivery-loop/store/artifact-store",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@terragon/shared/delivery-loop/store/artifact-store")
      >();
    approvePlanArtifactMock.mockImplementation(actual.approvePlanArtifact);
    return {
      ...actual,
      approvePlanArtifact: approvePlanArtifactMock,
    };
  },
);

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

    const loop = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "planning",
      stateJson: { planVersion: null },
      repoFullName: "owner/repo",
      userId: user.id,
    });
    expect(loop).toBeDefined();
    await ensureWorkflowHead({ db, workflowId: loop.id });

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

    const planArtifacts = await db.query.deliveryPhaseArtifact.findMany({
      where: and(
        eq(schema.deliveryPhaseArtifact.loopId, loop.id),
        eq(schema.deliveryPhaseArtifact.phase, "planning"),
      ),
    });
    expect(planArtifacts).toHaveLength(1);
    expect(planArtifacts[0]?.status).toBe("accepted");
    const exitPlanPayload = planArtifacts[0]?.payload as
      | { source?: string }
      | undefined;
    expect(exitPlanPayload?.source).toBe("exit_plan_mode");

    const planTasks = await db.query.deliveryPlanTask.findMany({
      where: and(
        eq(schema.deliveryPlanTask.loopId, loop.id),
        eq(schema.deliveryPlanTask.artifactId, planArtifacts[0]!.id),
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

    const loop = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "planning",
      stateJson: { planVersion: null },
      repoFullName: "owner/repo",
      userId: user.id,
      planApprovalPolicy: "human_required",
    });
    expect(loop.planApprovalPolicy).toBe("human_required");
    await ensureWorkflowHead({ db, workflowId: loop.id });

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

    const artifact = await db.query.deliveryPhaseArtifact.findFirst({
      where: and(
        eq(schema.deliveryPhaseArtifact.loopId, loop.id),
        eq(schema.deliveryPhaseArtifact.phase, "planning"),
      ),
      orderBy: [schema.deliveryPhaseArtifact.createdAt],
    });
    expect(artifact?.status).toBe("approved");
    expect(artifact?.approvedByUserId).toBe(user.id);
    const writeToolPayload = artifact?.payload as
      | { source?: string }
      | undefined;
    expect(writeToolPayload?.source).toBe("write_tool");
  });

  it("approves and promotes an existing generated planning artifact for human_required policy", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    await mockLoggedInUser(session);

    const loop = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "planning",
      stateJson: { planVersion: null },
      repoFullName: "owner/repo",
      userId: user.id,
      planApprovalPolicy: "human_required",
    });
    await ensureWorkflowHead({ db, workflowId: loop.id });
    const existingArtifact = await createPlanArtifact({
      db,
      loopId: loop.id,
      loopVersion: 1,
      status: "generated",
      generatedBy: "agent",
      payload: {
        planText: "Existing generated plan",
        source: "system",
        tasks: [
          {
            stableTaskId: "task-1",
            title: "Task one",
            acceptance: ["Done"],
          },
        ],
      },
    });
    await replacePlanTasksForArtifact({
      db,
      loopId: loop.id,
      artifactId: existingArtifact.id,
      tasks: [
        {
          stableTaskId: "task-1",
          title: "Task one",
          acceptance: ["Done"],
        },
      ],
    });

    await updateThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
      updates: {
        appendMessages: [
          {
            type: "tool-call",
            id: "exit-plan-existing",
            name: "ExitPlanMode",
            parent_tool_use_id: null,
            parameters: {
              plan: JSON.stringify({
                planText: "Existing generated plan",
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
        ],
      },
    });

    await approvePlan({ threadId, threadChatId });

    const planningArtifacts = await db.query.deliveryPhaseArtifact.findMany({
      where: and(
        eq(schema.deliveryPhaseArtifact.loopId, loop.id),
        eq(schema.deliveryPhaseArtifact.phase, "planning"),
      ),
    });
    expect(planningArtifacts).toHaveLength(1);
    expect(planningArtifacts[0]?.id).toBe(existingArtifact.id);
    expect(planningArtifacts[0]?.status).toBe("approved");
  });

  it("promotes an existing approved artifact instead of stale generated candidate", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    await mockLoggedInUser(session);

    const loop = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "planning",
      stateJson: { planVersion: null },
      repoFullName: "owner/repo",
      userId: user.id,
      planApprovalPolicy: "human_required",
    });
    expect(loop).toBeDefined();
    await ensureWorkflowHead({ db, workflowId: loop.id });

    const staleGeneratedPayload = {
      planText: "Stale generated plan",
      source: "exit_plan_mode" as const,
      tasks: [
        {
          stableTaskId: "task-stale",
          title: "Stale task",
          acceptance: ["Old"],
        },
      ],
    };
    const newestApprovedPayload = {
      planText: "Newest approved plan",
      source: "exit_plan_mode" as const,
      tasks: [
        {
          stableTaskId: "task-new",
          title: "Newest task",
          acceptance: ["Current"],
        },
      ],
    };
    const staleCreatedAt = new Date("2026-03-09T12:00:30.000Z");
    const approvedCreatedAt = new Date("2026-03-09T12:00:10.000Z");

    const [staleGeneratedArtifact] = await db
      .insert(schema.deliveryPhaseArtifact)
      .values({
        loopId: loop.id,
        phase: "planning",
        artifactType: "plan_spec",
        headSha: null,
        loopVersion: 2,
        status: "generated",
        generatedBy: "agent",
        payload: staleGeneratedPayload,
        createdAt: staleCreatedAt,
        updatedAt: staleCreatedAt,
      })
      .returning();

    const [approvedArtifact] = await db
      .insert(schema.deliveryPhaseArtifact)
      .values({
        loopId: loop.id,
        phase: "planning",
        artifactType: "plan_spec",
        headSha: null,
        loopVersion: 3,
        status: "approved",
        approvedByUserId: user.id,
        approvedAt: approvedCreatedAt,
        generatedBy: "agent",
        payload: newestApprovedPayload,
        createdAt: approvedCreatedAt,
        updatedAt: approvedCreatedAt,
      })
      .returning();

    expect(staleGeneratedArtifact).toBeDefined();
    expect(approvedArtifact).toBeDefined();
    if (!staleGeneratedArtifact || !approvedArtifact) {
      throw new Error("Expected artifacts to be inserted");
    }

    await replacePlanTasksForArtifact({
      db,
      loopId: loop.id,
      artifactId: staleGeneratedArtifact.id,
      tasks: staleGeneratedPayload.tasks,
    });
    await replacePlanTasksForArtifact({
      db,
      loopId: loop.id,
      artifactId: approvedArtifact.id,
      tasks: newestApprovedPayload.tasks,
    });

    await updateThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
      updates: {
        appendMessages: [
          {
            type: "tool-call",
            id: "exit-plan-approved",
            name: "ExitPlanMode",
            parent_tool_use_id: null,
            parameters: {
              plan: JSON.stringify(newestApprovedPayload),
            },
          },
        ],
      },
    });

    await approvePlan({ threadId, threadChatId });

    const [refreshedStale, refreshedApproved] = await Promise.all([
      db.query.deliveryPhaseArtifact.findFirst({
        where: eq(schema.deliveryPhaseArtifact.id, staleGeneratedArtifact.id),
      }),
      db.query.deliveryPhaseArtifact.findFirst({
        where: eq(schema.deliveryPhaseArtifact.id, approvedArtifact.id),
      }),
    ]);
    expect(refreshedStale?.status).toBe("generated");
    expect(refreshedApproved?.status).toBe("approved");
  });

  it("does not promote an unrelated approved artifact when parsed plan mismatches", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    await mockLoggedInUser(session);

    const loop = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "planning",
      stateJson: { planVersion: null },
      repoFullName: "owner/repo",
      userId: user.id,
      planApprovalPolicy: "human_required",
    });
    expect(loop).toBeDefined();
    await ensureWorkflowHead({ db, workflowId: loop.id });

    const staleApprovedPayload = {
      planText: "Previously approved plan",
      source: "exit_plan_mode" as const,
      tasks: [
        {
          stableTaskId: "task-stale",
          title: "Stale task",
          acceptance: ["Old"],
        },
      ],
    };
    const parsedPlanPayload = {
      planText: "New plan from current approval context",
      source: "exit_plan_mode" as const,
      tasks: [
        {
          stableTaskId: "task-new",
          title: "New task",
          acceptance: ["Current"],
        },
      ],
    };

    const [staleApprovedArtifact] = await db
      .insert(schema.deliveryPhaseArtifact)
      .values({
        loopId: loop.id,
        phase: "planning",
        artifactType: "plan_spec",
        headSha: null,
        loopVersion: 2,
        status: "approved",
        approvedByUserId: user.id,
        approvedAt: new Date("2026-03-09T13:00:00.000Z"),
        generatedBy: "agent",
        payload: staleApprovedPayload,
        createdAt: new Date("2026-03-09T13:00:00.000Z"),
        updatedAt: new Date("2026-03-09T13:00:00.000Z"),
      })
      .returning();
    expect(staleApprovedArtifact).toBeDefined();
    if (!staleApprovedArtifact) {
      throw new Error("Expected stale approved artifact to be inserted");
    }

    await replacePlanTasksForArtifact({
      db,
      loopId: loop.id,
      artifactId: staleApprovedArtifact.id,
      tasks: staleApprovedPayload.tasks,
    });

    await updateThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
      updates: {
        appendMessages: [
          {
            type: "tool-call",
            id: "exit-plan-mismatch",
            name: "ExitPlanMode",
            parent_tool_use_id: null,
            parameters: {
              plan: JSON.stringify(parsedPlanPayload),
            },
          },
        ],
      },
    });

    await approvePlan({ threadId, threadChatId });

    // The new artifact (matching parsedPlanPayload) should be approved
    const approvedArtifact = await db.query.deliveryPhaseArtifact.findFirst({
      where: and(
        eq(schema.deliveryPhaseArtifact.loopId, loop.id),
        eq(schema.deliveryPhaseArtifact.status, "approved"),
        eq(schema.deliveryPhaseArtifact.phase, "planning"),
      ),
    });
    expect(approvedArtifact?.id).not.toBe(staleApprovedArtifact.id);
    expect(
      (approvedArtifact?.payload as { planText?: string } | undefined)
        ?.planText,
    ).toBe(parsedPlanPayload.planText);
  });

  it("does not fallback to unrelated approved artifact when approval CAS is lost", async () => {
    const { user, session } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    await mockLoggedInUser(session);

    const loop = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "planning",
      stateJson: { planVersion: null },
      repoFullName: "owner/repo",
      userId: user.id,
      planApprovalPolicy: "human_required",
    });
    expect(loop).toBeDefined();
    await ensureWorkflowHead({ db, workflowId: loop.id });

    const matchingGeneratedPayload = {
      planText: "Plan that should be approved",
      source: "exit_plan_mode" as const,
      tasks: [
        {
          stableTaskId: "task-match",
          title: "Matching task",
          acceptance: ["Current"],
        },
      ],
    };
    const unrelatedApprovedPayload = {
      planText: "Unrelated approved plan",
      source: "exit_plan_mode" as const,
      tasks: [
        {
          stableTaskId: "task-unrelated",
          title: "Unrelated task",
          acceptance: ["Other"],
        },
      ],
    };

    const generatedArtifact = await createPlanArtifact({
      db,
      loopId: loop.id,
      loopVersion: 1,
      status: "generated",
      generatedBy: "agent",
      payload: matchingGeneratedPayload,
    });
    await replacePlanTasksForArtifact({
      db,
      loopId: loop.id,
      artifactId: generatedArtifact.id,
      tasks: matchingGeneratedPayload.tasks,
    });

    const [unrelatedApprovedArtifact] = await db
      .insert(schema.deliveryPhaseArtifact)
      .values({
        loopId: loop.id,
        phase: "planning",
        artifactType: "plan_spec",
        headSha: null,
        loopVersion: generatedArtifact.loopVersion + 1,
        status: "approved",
        approvedByUserId: user.id,
        approvedAt: new Date("2026-03-09T14:00:00.000Z"),
        generatedBy: "agent",
        payload: unrelatedApprovedPayload,
        createdAt: new Date("2026-03-09T14:00:00.000Z"),
        updatedAt: new Date("2026-03-09T14:00:00.000Z"),
      })
      .returning();
    expect(unrelatedApprovedArtifact).toBeDefined();
    if (!unrelatedApprovedArtifact) {
      throw new Error("Expected unrelated approved artifact to be inserted");
    }
    await replacePlanTasksForArtifact({
      db,
      loopId: loop.id,
      artifactId: unrelatedApprovedArtifact.id,
      tasks: unrelatedApprovedPayload.tasks,
    });

    await updateThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
      updates: {
        appendMessages: [
          {
            type: "tool-call",
            id: "exit-plan-cas-fallback",
            name: "ExitPlanMode",
            parent_tool_use_id: null,
            parameters: {
              plan: JSON.stringify(matchingGeneratedPayload),
            },
          },
        ],
      },
    });

    approvePlanArtifactMock.mockResolvedValueOnce(undefined);

    await expect(approvePlan({ threadId, threadChatId })).rejects.toThrow(
      "Failed to approve plan",
    );

    const activeWorkflow = await getActiveWorkflowForThread({ db, threadId });
    expect(activeWorkflow?.kind).toBe("planning");
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

    const loopNoArtifact = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "planning",
      stateJson: { planVersion: null },
      repoFullName: "owner/repo",
      userId: user.id,
    });
    await ensureWorkflowHead({ db, workflowId: loopNoArtifact.id });

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

    const workflow = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "implementing",
      stateJson: {},
      repoFullName: "owner/repo",
      userId: user.id,
    });
    expect(workflow).toBeDefined();
    await ensureWorkflowHead({ db, workflowId: workflow.id });

    await expect(approvePlan({ threadId, threadChatId })).rejects.toThrow(
      "planning phase",
    );
  });
});
