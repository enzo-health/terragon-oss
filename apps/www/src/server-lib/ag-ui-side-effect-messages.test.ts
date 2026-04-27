import { EventType, type BaseEvent } from "@ag-ui/core";
import type { DBSystemMessage, DBUserMessage } from "@terragon/shared";
import { env } from "@terragon/env/apps-www";
import { createDb } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const redisMocks = vi.hoisted(() => ({
  xadd: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  redis: redisMocks,
}));

const {
  getLatestNativeAgUiSnapshotMessage,
  getNativeAgUiTranscriptForThreadChat,
  hasInvalidTokenRetrySideEffectMarker,
  hasNativeAgUiUserMessage,
  persistInvalidTokenRetrySideEffectMarker,
  persistSideEffectAgUiMessages,
} = await import("./ag-ui-side-effect-messages");

const db = createDb(env.DATABASE_URL);

const userMessage = {
  type: "user",
  model: null,
  parts: [
    { type: "text", text: "Follow up" },
    {
      type: "rich-text",
      nodes: [
        { type: "text", text: " with " },
        { type: "mention", text: "@context" },
      ],
    },
  ],
  timestamp: "2026-04-27T10:00:00.000Z",
} satisfies DBUserMessage;

const systemMessage = {
  type: "system",
  message_type: "compact-result",
  parts: [{ type: "text", text: "Compacted" }],
  timestamp: "2026-04-27T10:01:00.000Z",
} satisfies DBSystemMessage;

describe("ag-ui-side-effect-messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMocks.xadd.mockResolvedValue("stream-id");
  });

  it("persists a deterministic native AG UI messages snapshot envelope", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });

    await persistSideEffectAgUiMessages({
      db,
      threadId,
      threadChatId,
      messages: [userMessage, systemMessage],
      source: "unit-test",
      chatSequence: 42,
      runId: "run-side-effect-1",
    });

    const rows = await db
      .select()
      .from(schema.agentEventLog)
      .where(eq(schema.agentEventLog.threadChatId, threadChatId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBe("run-side-effect-1");
    expect(rows[0]?.eventId).toMatch(/^side-effect:unit-test:42:/);
    const event = rows[0]?.payloadJson as BaseEvent | undefined;
    expect(event).toMatchObject({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        expect.objectContaining({
          role: "user",
          content: "Follow up\n with @context",
        }),
        expect.objectContaining({ role: "system", content: "Compacted" }),
      ],
    });
    expect(rows[0]?.seq).toBe(0);
  });

  it("reads daemon-owned side-effect snapshot facts from the AG UI event log", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });
    const retryMarker = {
      type: "system",
      message_type: "invalid-token-retry",
      parts: [{ type: "text", text: "Retry failed" }],
      timestamp: "2026-04-27T10:02:00.000Z",
    } satisfies DBSystemMessage;

    await persistSideEffectAgUiMessages({
      db,
      threadId,
      threadChatId,
      messages: [userMessage, retryMarker],
      source: "unit-test",
      chatSequence: 43,
      runId: "run-side-effect-2",
    });

    await expect(hasNativeAgUiUserMessage({ db, threadChatId })).resolves.toBe(
      true,
    );
    await expect(
      getLatestNativeAgUiSnapshotMessage({ db, threadChatId }),
    ).resolves.toEqual({
      role: "system",
      messageType: "invalid-token-retry",
      content: "Retry failed",
    });
    await expect(
      getNativeAgUiTranscriptForThreadChat({ db, threadChatId }),
    ).resolves.toMatchObject({
      history: expect.stringContaining("user: Follow up"),
      messageCount: 2,
    });
  });

  it("does not persist when an append batch has no user or system messages", async () => {
    await persistSideEffectAgUiMessages({
      db: {} as never,
      threadId: "thread-1",
      threadChatId: "chat-1",
      messages: [{ type: "thread-context-result", summary: "skip" }],
      source: "unit-test",
    });

    expect(redisMocks.xadd).not.toHaveBeenCalled();
  });

  it("skips unsupported thread-lifecycle system messages", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });

    await persistSideEffectAgUiMessages({
      db,
      threadId,
      threadChatId,
      messages: [
        {
          type: "system",
          message_type: "follow-up-retry-failed",
          parts: [{ type: "text", text: "Retry failed" }],
        },
      ],
      source: "unit-test",
      runId: "run-side-effect-unsupported",
    });

    const rows = await db
      .select()
      .from(schema.agentEventLog)
      .where(eq(schema.agentEventLog.threadChatId, threadChatId));
    expect(rows).toHaveLength(0);
  });

  it("skips persistence when no native run can be resolved", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });

    await persistSideEffectAgUiMessages({
      db,
      threadId,
      threadChatId,
      messages: [userMessage],
      source: "unit-test",
    });

    const rows = await db
      .select()
      .from(schema.agentEventLog)
      .where(eq(schema.agentEventLog.threadChatId, threadChatId));
    expect(rows).toHaveLength(0);
  });

  it("persists and finds the invalid-token retry side-effect marker", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });

    await expect(
      hasInvalidTokenRetrySideEffectMarker({ db, threadChatId }),
    ).resolves.toBe(false);

    await persistInvalidTokenRetrySideEffectMarker({
      db,
      threadId,
      threadChatId,
      runId: "run-invalid-token",
      chatSequence: 7,
    });

    await expect(
      hasInvalidTokenRetrySideEffectMarker({ db, threadChatId }),
    ).resolves.toBe(true);

    const rows = await db
      .select()
      .from(schema.agentEventLog)
      .where(eq(schema.agentEventLog.threadChatId, threadChatId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventId).toMatch(/^side-effect:invalid-token-retry:7:/);
    expect(rows[0]?.payloadJson).toMatchObject({
      type: EventType.CUSTOM,
      name: "terragon.side-effect.invalid-token-retry",
      value: {
        reason: "oauth-token-revoked",
        threadId,
        threadChatId,
      },
    });
  });
});
