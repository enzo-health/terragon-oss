import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { mockLoggedInUser } from "@/test-helpers/mock-next";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import * as schema from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { getUser } from "@terragon/shared/model/user";
import { createWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import { ensureWorkflowHead } from "@/server-lib/delivery-loop/v3/store";
import { upsertAgentRunContext } from "@terragon/shared/model/agent-run-context";
import { EventType } from "@ag-ui/core";
import { getTaskLivenessDebugPayload } from "./task-liveness-debug";

const redisMocks = vi.hoisted(() => {
  const xrevrange = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
    Promise.resolve({}),
  );
  return { xrevrange };
});

vi.mock("@/lib/redis", () => ({
  redis: {
    xrevrange: redisMocks.xrevrange,
  },
}));

describe("getTaskLivenessDebugPayload", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T00:05:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function createAdminUser() {
    const { user, session } = await createTestUser({ db });
    await db
      .update(schema.user)
      .set({ role: "admin" })
      .where(eq(schema.user.id, user.id));
    const updatedUser = await getUser({ db, userId: user.id });
    return { user: updatedUser!, session };
  }

  it("joins liveness surfaces and explains a delivery-loop head override + terminal marker", async () => {
    const { session: adminSession } = await createAdminUser();
    const { user: owner } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: owner.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });

    await db
      .update(schema.threadChat)
      .set({
        status: "complete",
        messageSeq: 10,
        updatedAt: new Date("2026-04-22T00:01:00.000Z"),
      })
      .where(eq(schema.threadChat.id, threadChatId));

    const workflow = await createWorkflow({
      db,
      threadId,
      generation: 1,
      kind: "implementing",
      stateJson: {},
      userId: owner.id,
      repoFullName: "owner/repo",
    });
    await ensureWorkflowHead({ db, workflowId: workflow.id });
    await db
      .update(schema.deliveryWorkflowHeadV3)
      .set({
        state: "implementing",
        activeRunId: "run-123",
        activeRunSeq: 42,
        updatedAt: new Date("2026-04-22T00:04:00.000Z"),
        lastActivityAt: new Date("2026-04-22T00:04:00.000Z"),
      })
      .where(eq(schema.deliveryWorkflowHeadV3.workflowId, workflow.id));

    await upsertAgentRunContext({
      db,
      runId: "run-123",
      workflowId: workflow.id,
      runSeq: 42,
      userId: owner.id,
      threadId,
      threadChatId,
      sandboxId: "sb-1",
      transportMode: "legacy",
      protocolVersion: 2,
      agent: "codex",
      permissionMode: "allowAll",
      requestedSessionId: null,
      resolvedSessionId: null,
      status: "processing",
      tokenNonce: "nonce-1",
      daemonTokenKeyId: null,
    });

    await db.insert(schema.agentEventLog).values({
      eventId: "evt-run-started",
      runId: "run-123",
      threadId,
      threadChatId,
      seq: 1,
      eventType: EventType.RUN_STARTED,
      category: EventType.RUN_STARTED,
      payloadJson: {
        type: EventType.RUN_STARTED,
        runId: "run-123",
      },
      idempotencyKey: "run-123:evt-run-started",
      timestamp: new Date("2026-04-22T00:04:00.000Z"),
      threadChatMessageSeq: null,
    });

    redisMocks.xrevrange.mockResolvedValue({
      // Redis IDs are ms-time-based; only the prefix is used by the parser.
      "1776816240000-0": {
        event: JSON.stringify({
          type: EventType.RUN_FINISHED,
          runId: "run-123",
        }),
      },
    });

    await mockLoggedInUser(adminSession);

    const payload = await getTaskLivenessDebugPayload({ threadId });

    expect(payload.threadId).toBe(threadId);
    expect(payload.threadChatId).toBe(threadChatId);
    expect(payload.ui.threadChatStatus).toBe("complete");
    expect(payload.ui.deliveryLoopState).toBe("implementing");
    expect(payload.ui.canApplyDeliveryLoopHeadOverride).toBe(true);
    expect(payload.ui.effectiveThreadStatus).toBe("working");
    expect(payload.ui.isWorking).toBe(true);
    expect(payload.ui.livenessEvidence.kind).toBe("fresh");
    expect(payload.summary).toContain("override=deliveryLoopHead");

    expect(payload.surfaces.workflowHeadV3?.activeRunId).toBe("run-123");
    expect(payload.surfaces.agentRunContext.forActiveRunId?.runId).toBe(
      "run-123",
    );
    expect(payload.surfaces.agentEventLog.latestWellFormedRunId).toBe(
      "run-123",
    );
    expect(payload.surfaces.threadChat).not.toHaveProperty("errorMessageInfo");
    expect(payload.surfaces.redisAgUiStream.targetRunId).toBe("run-123");
    expect(payload.surfaces.redisAgUiStream.availability).toBe("available");
    expect(payload.surfaces.redisAgUiStream.unavailableReason).toBeNull();
    expect(payload.surfaces.redisAgUiStream.hasTerminalMarkerForTargetRun).toBe(
      true,
    );
    expect(payload.surfaces.redisAgUiStream.latestTerminalMarker?.runId).toBe(
      "run-123",
    );
  });

  it("falls back to replay run id when workflow head is absent and reports missing terminal marker", async () => {
    const { session: adminSession } = await createAdminUser();
    const { user: owner } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: owner.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });

    await db
      .update(schema.threadChat)
      .set({
        status: "working",
        messageSeq: 3,
        updatedAt: new Date("2026-04-22T00:02:00.000Z"),
      })
      .where(eq(schema.threadChat.id, threadChatId));

    await db.insert(schema.agentEventLog).values({
      eventId: "evt-run-started-replay",
      runId: "run-replay",
      threadId,
      threadChatId,
      seq: 1,
      eventType: EventType.RUN_STARTED,
      category: EventType.RUN_STARTED,
      payloadJson: {
        type: EventType.RUN_STARTED,
        runId: "run-replay",
      },
      idempotencyKey: "run-replay:evt-run-started-replay",
      timestamp: new Date("2026-04-22T00:02:00.000Z"),
      threadChatMessageSeq: 3,
    });

    redisMocks.xrevrange.mockResolvedValue({
      "1776816120000-0": {
        event: JSON.stringify({
          type: EventType.RUN_FINISHED,
          runId: "run-other",
        }),
      },
    });

    await mockLoggedInUser(adminSession);

    const payload = await getTaskLivenessDebugPayload({ threadId });

    expect(payload.surfaces.workflowHeadV3).toBeNull();
    expect(payload.surfaces.agentRunContext.latestForThreadChat).toBeNull();
    expect(payload.surfaces.agentRunContext.forActiveRunId).toBeNull();
    expect(payload.surfaces.agentEventLog.latestWellFormedRunId).toBe(
      "run-replay",
    );
    expect(payload.surfaces.redisAgUiStream.targetRunId).toBe("run-replay");
    expect(payload.surfaces.redisAgUiStream.availability).toBe("available");
    expect(payload.surfaces.redisAgUiStream.unavailableReason).toBeNull();
    expect(payload.surfaces.redisAgUiStream.hasTerminalMarkerForTargetRun).toBe(
      false,
    );
    expect(payload.summary).toContain("targetRunId=run-replay");
    expect(payload.summary).toContain("redisTerminalMarker=missing");
  });

  it("fails soft when redis stream tail lookup throws", async () => {
    const { session: adminSession } = await createAdminUser();
    const { user: owner } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: owner.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });

    await db.insert(schema.agentEventLog).values({
      eventId: "evt-run-started-redis-fail",
      runId: "run-redis-fail",
      threadId,
      threadChatId,
      seq: 1,
      eventType: EventType.RUN_STARTED,
      category: EventType.RUN_STARTED,
      payloadJson: {
        type: EventType.RUN_STARTED,
        runId: "run-redis-fail",
      },
      idempotencyKey: "run-redis-fail:evt-run-started-redis-fail",
      timestamp: new Date("2026-04-22T00:03:00.000Z"),
      threadChatMessageSeq: 1,
    });

    redisMocks.xrevrange.mockRejectedValue(new Error("transient redis outage"));
    await mockLoggedInUser(adminSession);

    await expect(getTaskLivenessDebugPayload({ threadId })).resolves.toEqual(
      expect.objectContaining({
        threadId,
        threadChatId,
        surfaces: expect.objectContaining({
          redisAgUiStream: expect.objectContaining({
            availability: "unavailable",
            unavailableReason: "xrevrange_failed",
            sampledTailSize: 0,
            latestEntryId: null,
          }),
        }),
      }),
    );
  });

  it("ignores malformed redis stream entries and keeps well-formed markers", async () => {
    const { session: adminSession } = await createAdminUser();
    const { user: owner } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: owner.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });

    await db.insert(schema.agentEventLog).values({
      eventId: "evt-run-started-malformed",
      runId: "run-malformed",
      threadId,
      threadChatId,
      seq: 1,
      eventType: EventType.RUN_STARTED,
      category: EventType.RUN_STARTED,
      payloadJson: {
        type: EventType.RUN_STARTED,
        runId: "run-malformed",
      },
      idempotencyKey: "run-malformed:evt-run-started-malformed",
      timestamp: new Date("2026-04-22T00:03:00.000Z"),
      threadChatMessageSeq: 1,
    });

    redisMocks.xrevrange.mockResolvedValue({
      "1776816180000-0": {
        event: "{not-json",
      },
      "1776816181000-0": {
        event: JSON.stringify({ runId: "run-malformed" }),
      },
      "1776816182000-0": {
        notEvent: "missing-event-field",
      },
      "1776816183000-0": [
        "event",
        JSON.stringify({
          type: EventType.RUN_FINISHED,
          runId: "run-malformed",
        }),
      ],
    });

    await mockLoggedInUser(adminSession);

    const payload = await getTaskLivenessDebugPayload({ threadId });

    expect(payload.surfaces.redisAgUiStream.availability).toBe("available");
    expect(payload.surfaces.redisAgUiStream.sampledTailSize).toBe(1);
    expect(payload.surfaces.redisAgUiStream.hasTerminalMarkerForTargetRun).toBe(
      true,
    );
    expect(payload.surfaces.redisAgUiStream.latestTerminalMarker).toEqual(
      expect.objectContaining({
        runId: "run-malformed",
        type: EventType.RUN_FINISHED,
      }),
    );
  });
});
