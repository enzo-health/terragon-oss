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
  getDurableAgUiHistoryItemsFromEvents,
  getNativeAgUiHistoryMessagesFromEvents,
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

  it("builds side-effect snapshot history from durable user/system snapshot events only", () => {
    const events = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 1,
        messages: [
          { id: "user-1", role: "user", content: "Initial prompt" },
          {
            id: "side-effect-system:invalid-token-retry",
            role: "system",
            content: "Retrying after invalid token",
          },
        ],
      },
      {
        type: EventType.RUN_STARTED,
        timestamp: 2,
        threadId: "thread-1",
        runId: "run-1",
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 3,
        messageId: "assistant-1",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 4,
        messageId: "assistant-1",
        delta: "Assistant replay comes from SSE",
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: 5,
        messageId: "assistant-1",
      },
    ] satisfies BaseEvent[];

    expect(getNativeAgUiHistoryMessagesFromEvents(events)).toEqual([
      { id: "user-1", role: "user", content: "Initial prompt" },
      {
        id: "side-effect-system:invalid-token-retry",
        role: "system",
        content: "Retrying after invalid token",
      },
    ]);
  });

  it("preserves failed tool results in durable assistant-ui history", () => {
    const events = [
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 1,
        messageId: "assistant-1",
        role: "assistant",
      },
      {
        type: EventType.TOOL_CALL_START,
        timestamp: 2,
        toolCallId: "tool-1",
        toolCallName: "Bash",
        parentMessageId: "assistant-1",
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        timestamp: 3,
        messageId: "tool-result-1",
        toolCallId: "tool-1",
        content: "permission denied",
        isError: true,
      },
    ] satisfies BaseEvent[];

    expect(getDurableAgUiHistoryItemsFromEvents(events)).toEqual({
      items: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tool-1",
              type: "function",
              function: {
                name: "Bash",
                arguments: "",
              },
            },
          ],
        },
        {
          id: "tool-result-1",
          role: "tool",
          toolCallId: "tool-1",
          content: "permission denied",
          error: "permission denied",
        },
      ],
      lastSeqOffset: 2,
    });
  });

  it("builds durable runtime-owned transcript history from AG UI history/live events", () => {
    const events = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 1,
        messages: [{ id: "user-1", role: "user", content: "Initial prompt" }],
      },
      {
        type: EventType.RUN_STARTED,
        timestamp: 2,
        threadId: "thread-1",
        runId: "run-1",
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 3,
        messageId: "assistant-1",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 4,
        messageId: "assistant-1",
        delta: "Assistant transcript",
      },
      {
        type: EventType.TOOL_CALL_START,
        timestamp: 5,
        toolCallId: "tool-1",
        toolCallName: "Bash",
        parentMessageId: "assistant-1",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: 6,
        toolCallId: "tool-1",
        delta: '{"command":"pnpm test"}',
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        timestamp: 7,
        messageId: "tool-result-1",
        toolCallId: "tool-1",
        content: "passed",
      },
      {
        type: EventType.CUSTOM,
        timestamp: 8,
        name: "terragon.data-part",
        value: {
          messageId: "assistant-1",
          partIndex: 1,
          name: "terragon.terminal",
          data: {
            type: "terminal",
            sandboxId: "sandbox-1",
            terminalId: "terminal-1",
            chunks: [],
          },
        },
      },
      {
        type: EventType.RUN_FINISHED,
        timestamp: 9,
        threadId: "thread-1",
        runId: "run-1",
      },
    ] satisfies BaseEvent[];

    expect(getDurableAgUiHistoryItemsFromEvents(events)).toEqual({
      items: [
        { id: "user-1", role: "user", content: "Initial prompt" },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Assistant transcript",
          toolCalls: [
            {
              id: "tool-1",
              type: "function",
              function: {
                name: "Bash",
                arguments: '{"command":"pnpm test"}',
              },
            },
          ],
        },
        {
          id: "tool-result-1",
          role: "tool",
          toolCallId: "tool-1",
          content: "passed",
        },
        {
          type: EventType.CUSTOM,
          timestamp: 8,
          name: "terragon.data-part",
          value: {
            messageId: "assistant-1",
            partIndex: 1,
            name: "terragon.terminal",
            data: {
              type: "terminal",
              sandboxId: "sandbox-1",
              terminalId: "terminal-1",
              chunks: [],
            },
          },
        },
      ],
      lastSeqOffset: 7,
    });
  });

  it("does not advance durable history cursor for trailing message or tool end events", () => {
    const textHistory = getDurableAgUiHistoryItemsFromEvents([
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 1,
        messageId: "assistant-1",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 2,
        messageId: "assistant-1",
        delta: "Visible history",
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: 3,
        messageId: "assistant-1",
      },
    ] satisfies BaseEvent[]);
    expect(textHistory.lastSeqOffset).toBe(1);

    const toolHistory = getDurableAgUiHistoryItemsFromEvents([
      {
        type: EventType.TOOL_CALL_START,
        timestamp: 1,
        toolCallId: "tool-1",
        toolCallName: "Bash",
        parentMessageId: "assistant-1",
      },
      {
        type: EventType.TOOL_CALL_END,
        timestamp: 2,
        toolCallId: "tool-1",
      },
    ] satisfies BaseEvent[]);
    expect(toolHistory.lastSeqOffset).toBe(0);
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
      type: EventType.RAW,
      source: "terragon.side-effect.invalid-token-retry",
      event: {
        reason: "oauth-token-revoked",
        threadId,
        threadChatId,
      },
    });
  });
});
