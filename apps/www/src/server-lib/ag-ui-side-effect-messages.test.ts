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

  it("deduplicates repeated snapshot message ids in durable history", () => {
    const events = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 1,
        messages: [{ id: "user-1", role: "user", content: "Initial prompt" }],
      },
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 2,
        messages: [{ id: "user-1", role: "user", content: "Initial prompt" }],
      },
    ] satisfies BaseEvent[];

    expect(getDurableAgUiHistoryItemsFromEvents(events)).toEqual({
      items: [{ id: "user-1", role: "user", content: "Initial prompt" }],
      lastSeqOffset: 0,
    });
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

  it("treats role tool results as successful unless an error is explicit", () => {
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
        role: "tool",
        content: "passed",
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
          content: "passed",
        },
      ],
      lastSeqOffset: 2,
    });
  });

  it("synthesizes failed tool results for unresolved tool calls on run finish", () => {
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
        toolCallName: "Task",
        parentMessageId: "assistant-1",
      },
      {
        type: EventType.TOOL_CALL_END,
        timestamp: 3,
        toolCallId: "tool-1",
      },
      {
        type: EventType.RUN_FINISHED,
        timestamp: 4,
        threadId: "thread-1",
        runId: "run-1",
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
                name: "Task",
                arguments: "",
              },
            },
          ],
        },
        {
          id: "tool-1:unresolved-result",
          role: "tool",
          toolCallId: "tool-1",
          content: "Tool call ended without a result.",
          error: "Tool call ended without a result.",
        },
      ],
      lastSeqOffset: 3,
    });
  });

  it("attaches nested tool starts that reference a parent tool id to the assistant message", () => {
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
        toolCallId: "parent-tool",
        toolCallName: "Task",
      },
      {
        type: EventType.TOOL_CALL_START,
        timestamp: 3,
        toolCallId: "nested-tool",
        toolCallName: "Task",
        parentMessageId: "parent-tool",
      },
    ] satisfies BaseEvent[];

    expect(getDurableAgUiHistoryItemsFromEvents(events).items).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "parent-tool",
            type: "function",
            function: { name: "Task", arguments: "" },
          },
          {
            id: "nested-tool",
            type: "function",
            function: { name: "Task", arguments: "" },
          },
        ],
      },
    ]);
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
      lastSeqOffset: 8,
    });
  });

  it("advances durable history cursor through represented message and tool end events", () => {
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
    expect(textHistory.lastSeqOffset).toBe(2);

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
    expect(toolHistory.lastSeqOffset).toBe(1);
  });

  it("does not advance durable history cursor through an active run start alone", () => {
    const history = getDurableAgUiHistoryItemsFromEvents([
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 1,
        messages: [{ id: "user-1", role: "user", content: "start here" }],
      },
      {
        type: EventType.RUN_STARTED,
        timestamp: 2,
        threadId: "thread-1",
        runId: "run-1",
      },
    ] satisfies BaseEvent[]);

    expect(history).toEqual({
      items: [{ id: "user-1", role: "user", content: "start here" }],
      lastSeqOffset: 0,
    });
  });

  it("does not advance durable history cursor through an empty second run", () => {
    const history = getDurableAgUiHistoryItemsFromEvents([
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 1,
        messages: [{ id: "user-1", role: "user", content: "Prompt" }],
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
        delta: "Visible first run",
      },
      {
        type: EventType.RUN_FINISHED,
        timestamp: 5,
        threadId: "thread-1",
        runId: "run-1",
      },
      {
        type: EventType.RUN_STARTED,
        timestamp: 6,
        threadId: "thread-1",
        runId: "run-2",
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 7,
        messageId: "assistant-empty",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: 8,
        messageId: "assistant-empty",
      },
      {
        type: EventType.RUN_FINISHED,
        timestamp: 9,
        threadId: "thread-1",
        runId: "run-2",
      },
    ] satisfies BaseEvent[]);

    expect(history).toEqual({
      items: [
        { id: "user-1", role: "user", content: "Prompt" },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Visible first run",
        },
      ],
      lastSeqOffset: 4,
    });
  });

  it("does not advance durable history cursor for trace-sideband custom noise", () => {
    const history = getDurableAgUiHistoryItemsFromEvents([
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 1,
        messages: [{ id: "user-1", role: "user", content: "Prompt" }],
      },
      {
        type: EventType.RUN_STARTED,
        timestamp: 2,
        threadId: "thread-1",
        runId: "run-1",
      },
      {
        type: EventType.CUSTOM,
        timestamp: 3,
        name: "terragon.trace.daemon_event.received",
        value: {
          kind: "terragon.trace.daemon_event.received",
          runId: "run-1",
          eventId: "trace-event-1",
        },
      },
      {
        type: EventType.RUN_FINISHED,
        timestamp: 4,
        threadId: "thread-1",
        runId: "run-1",
      },
    ] satisfies BaseEvent[]);

    expect(history).toEqual({
      items: [{ id: "user-1", role: "user", content: "Prompt" }],
      lastSeqOffset: 0,
    });
  });

  it("does not represent empty assistant text starts in durable history", () => {
    const history = getDurableAgUiHistoryItemsFromEvents([
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 1,
        messages: [{ id: "user-1", role: "user", content: "Prompt" }],
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 2,
        messageId: "assistant-empty",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: 3,
        messageId: "assistant-empty",
      },
      {
        type: EventType.RUN_FINISHED,
        timestamp: 4,
        threadId: "thread-1",
        runId: "run-1",
      },
    ] satisfies BaseEvent[]);

    expect(history).toEqual({
      items: [{ id: "user-1", role: "user", content: "Prompt" }],
      lastSeqOffset: 0,
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
          message_type: "fix-github-checks",
          parts: [{ type: "text", text: "Fix GitHub checks" }],
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
