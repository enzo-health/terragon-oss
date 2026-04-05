import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDaemonTokenAuthContextOrNull } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { POST } from "./route";
import * as schema from "@terragon/shared/db/schema";
import {
  createPlanArtifact,
  replacePlanTasksForArtifact,
} from "@terragon/shared/delivery-loop/store/artifact-store";
import { createWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { ensureWorkflowHead } from "@/server-lib/delivery-loop/v3/store";

vi.mock("@/lib/auth-server", () => ({
  getDaemonTokenAuthContextOrNull: vi.fn(),
}));

function buildDaemonAuthContext(params?: {
  threadId?: string;
  threadChatId?: string;
}) {
  return {
    userId: "daemon-user",
    keyId: "daemon-key",
    claims: {
      kind: "daemon-run" as const,
      runId: "run-1",
      threadId: params?.threadId ?? "thread-1",
      threadChatId: params?.threadChatId ?? "chat-1",
      sandboxId: "sandbox-1",
      agent: "claudeCode",
      transportMode: "acp" as const,
      protocolVersion: 2,
      providers: ["anthropic" as const],
      nonce: "nonce-1",
      issuedAt: Date.now(),
      exp: Date.now() + 60_000,
    },
  };
}

describe("sdlc/mark-tasks route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue(
      buildDaemonAuthContext(),
    );
  });

  it("uses the v3 head to resolve the active loop when the legacy row is terminal", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue(
      buildDaemonAuthContext({ threadId, threadChatId }),
    );

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
      })
      .where(eq(schema.deliveryWorkflowHeadV3.workflowId, workflow.id));

    const planArtifact = await createPlanArtifact({
      db,
      loopId: workflow.id,
      loopVersion: 1,
      status: "accepted",
      generatedBy: "agent",
      workflowId: workflow.id,
      payload: {
        planText: "Plan",
        source: "system",
        tasks: [
          {
            stableTaskId: "task-1",
            title: "Ship it",
            description: null,
            acceptance: ["Done"],
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
          title: "Ship it",
          description: null,
          acceptance: ["Done"],
        },
      ],
    });

    const response = await POST(
      new Request("http://localhost/api/sdlc/mark-tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          threadChatId,
          headSha: "abc123",
          completedTasks: [{ stableTaskId: "task-1", note: "finished" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      updatedTaskCount: 1,
    });

    const completedTask = await db.query.deliveryPlanTask.findFirst({
      where: and(
        eq(schema.deliveryPlanTask.loopId, workflow.id),
        eq(schema.deliveryPlanTask.artifactId, planArtifact.id),
        eq(schema.deliveryPlanTask.stableTaskId, "task-1"),
      ),
    });
    expect(completedTask?.status).toBe("done");
    expect(completedTask?.completionEvidence).toEqual({
      headSha: "abc123",
      note: "finished",
    });
  });

  it("returns no_active_loop when the v3 head is terminal", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue(
      buildDaemonAuthContext({ threadId, threadChatId }),
    );

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
        state: "terminated",
        blockedReason: "done",
      })
      .where(eq(schema.deliveryWorkflowHeadV3.workflowId, workflow.id));

    const response = await POST(
      new Request("http://localhost/api/sdlc/mark-tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          threadChatId,
          completedTasks: [{ stableTaskId: "task-1" }],
        }),
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "no_active_loop",
    });
  });

  it("rejects requests whose daemon token does not match the target thread chat", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue(
      buildDaemonAuthContext({
        threadId: "different-thread",
        threadChatId: threadChatId,
      }),
    );

    const response = await POST(
      new Request("http://localhost/api/sdlc/mark-tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          threadChatId,
          completedTasks: [{ stableTaskId: "task-1" }],
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "token_thread_mismatch",
    });
  });

  it("rejects malformed completion payloads", async () => {
    const response = await POST(
      new Request("http://localhost/api/sdlc/mark-tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-1",
          threadChatId: "chat-1",
          completedTasks: [],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "missing_required_fields",
    });
  });
});
