import { EventType, type BaseEvent } from "@ag-ui/core";
import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import { describe, expect, it, vi } from "vitest";
import type { DBMessage } from "../db/db-message";
import {
  agUiSnapshotToReplayMessages,
  applyContextResetToReplayEntries,
  canonicalEventToReplayMessage,
  dbMessagesToAgUiMessages,
  getDurableAgUiHistoryItemsFromEvents,
  readAgUiEnvelope,
  readAgUiPayload,
  readAllAgUiEnvelopes,
  type AgUiReadableRow,
} from "./persistent-message-projection";

function makeProjectionRow(
  payloadJson: Record<string, unknown>,
  overrides: Partial<AgUiReadableRow> = {},
): AgUiReadableRow {
  return {
    eventId: "event-1",
    runId: "run-1",
    threadId: "thread-1",
    threadChatId: "chat-1",
    seq: 1,
    eventType: "unknown",
    payloadJson,
    idempotencyKey: "run-1:event-1",
    timestamp: new Date("2026-05-31T00:00:00.000Z"),
    ...overrides,
  };
}

describe("persistent message projection", () => {
  it("hydrates DB user messages and can omit assistant history", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [
          { type: "text", text: "hello" },
          {
            type: "rich-text",
            nodes: [
              { type: "text", text: " @" },
              { type: "mention", text: "ctx" },
            ],
          },
        ],
      },
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "assistant replay" }],
      },
    ];

    expect(
      dbMessagesToAgUiMessages(dbMessages, {
        includeAssistantHistory: false,
      }),
    ).toEqual([
      {
        id: "hydrate-0",
        role: "user",
        content: "hello\n @ctx",
      },
    ]);
  });

  it("projects canonical assistant and tool events to replay messages", () => {
    const baseEvent = {
      payloadVersion: 2,
      eventId: "event-1",
      runId: "run-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      seq: 1,
      timestamp: "2026-05-31T00:00:00.000Z",
    } as const;

    expect(
      canonicalEventToReplayMessage({
        ...baseEvent,
        type: "assistant-message",
        category: "transcript",
        messageId: "message-1",
        content: "done",
      } satisfies CanonicalEvent),
    ).toEqual({
      type: "agent",
      parent_tool_use_id: null,
      parts: [{ type: "text", text: "done" }],
    });
    expect(
      canonicalEventToReplayMessage({
        ...baseEvent,
        eventId: "event-2",
        seq: 2,
        type: "tool-call-start",
        category: "tool_lifecycle",
        toolCallId: "tool-1",
        name: "bash",
        parameters: { command: "pnpm test" },
      } satisfies CanonicalEvent),
    ).toEqual({
      type: "tool-call",
      id: "tool-1",
      name: "bash",
      parameters: { command: "pnpm test" },
      parent_tool_use_id: null,
      status: "started",
    });
  });

  it("reads AG-UI event rows and deterministic envelopes", () => {
    const agUiEvent: Record<string, unknown> = {
      type: EventType.RUN_STARTED,
      timestamp: 1_700_000_000_000,
      threadId: "thread-1",
      runId: "run-1",
    };
    const row = makeProjectionRow(agUiEvent, {
      seq: 42,
      eventType: "RUN_STARTED",
    });

    expect(readAgUiPayload(row)).toEqual(agUiEvent);
    expect(readAgUiEnvelope(row)).toEqual({
      eventId: "event-1",
      seq: 42,
      projectionIndex: 0,
      projectionCount: 1,
      runId: "run-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      timestamp: "2026-05-31T00:00:00.000Z",
      idempotencyKey: "run-1:event-1",
      payload: agUiEvent,
    });
  });

  it("expands canonical rows into stable AG-UI envelope order", () => {
    const canonicalEvent = {
      payloadVersion: 2,
      eventId: "event-assistant",
      runId: "run-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      seq: 7,
      timestamp: "2026-05-31T00:00:00.000Z",
      type: "assistant-message",
      category: "transcript",
      messageId: "message-1",
      content: "done",
    } satisfies CanonicalEvent;
    const row = makeProjectionRow(
      canonicalEvent as unknown as Record<string, unknown>,
      {
        eventId: canonicalEvent.eventId,
        seq: canonicalEvent.seq,
        eventType: canonicalEvent.type,
      },
    );

    expect(readAgUiPayload(row)?.type).toBe(EventType.TEXT_MESSAGE_START);
    const envelopes = readAllAgUiEnvelopes(row);
    expect(envelopes.map((entry) => entry.payload.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    expect(
      envelopes.map((entry) => ({
        seq: entry.seq,
        projectionIndex: entry.projectionIndex,
        projectionCount: entry.projectionCount,
      })),
    ).toEqual([
      { seq: 7, projectionIndex: 0, projectionCount: 3 },
      { seq: 7, projectionIndex: 1, projectionCount: 3 },
      { seq: 7, projectionIndex: 2, projectionCount: 3 },
    ]);
  });

  it("warns on unrecognized row payloads", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(readAgUiPayload(makeProjectionRow({ garbage: true }))).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("projects AG-UI snapshots to replay messages and preserves user metadata", () => {
    const replayMessages = agUiSnapshotToReplayMessages({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        {
          id: "user-1",
          role: "user",
          name: "terragon-user:model=sonnet&permissionMode=plan",
          content: "Continue",
        },
        {
          id: "side-effect-system:compact-result-0-0123456789ab",
          role: "system",
          content: "Compacted",
        },
        {
          id: "ignored",
          role: "assistant",
          content: "native replay owns this",
        },
      ],
    });

    expect(replayMessages).toEqual([
      {
        type: "user",
        model: "sonnet",
        permissionMode: "plan",
        parts: [{ type: "text", text: "Continue" }],
      },
      {
        type: "system",
        message_type: "compact-result",
        parts: [{ type: "text", text: "Compacted" }],
      },
    ]);
  });

  it("applies compact-result replay resets across entries", () => {
    expect(
      applyContextResetToReplayEntries([
        {
          seq: 1,
          messages: [
            {
              type: "user",
              model: null,
              parts: [{ type: "text", text: "old" }],
            },
          ],
        },
        {
          seq: 2,
          messages: [
            {
              type: "system",
              message_type: "compact-result",
              parts: [{ type: "text", text: "reset" }],
            },
            {
              type: "user",
              model: null,
              parts: [{ type: "text", text: "new" }],
            },
          ],
        },
      ]),
    ).toEqual([
      {
        seq: 2,
        messages: [
          {
            type: "system",
            message_type: "compact-result",
            parts: [{ type: "text", text: "reset" }],
          },
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "new" }],
          },
        ],
      },
    ]);
  });

  it("projects streamed assistant text into durable history", () => {
    const result = getDurableAgUiHistoryItemsFromEvents([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-1",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-1",
        delta: "Hello",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-1",
        delta: " world",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "message-1",
      } as BaseEvent,
    ]);

    expect(result).toEqual({
      items: [{ id: "message-1", role: "assistant", content: "Hello world" }],
      lastSeqOffset: 3,
    });
  });

  it("keeps tool arguments and result attached to the assistant turn", () => {
    const result = getDurableAgUiHistoryItemsFromEvents([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-1",
        delta: "Running tests",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "bash",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: '{"command":"pnpm test"}',
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tool-result-1",
        toolCallId: "tool-1",
        content: "ok",
      } as BaseEvent,
    ]);

    expect(result.items).toEqual([
      {
        id: "message-1",
        role: "assistant",
        content: "Running tests",
        toolCalls: [
          {
            id: "tool-1",
            type: "function",
            function: {
              name: "bash",
              arguments: '{"command":"pnpm test"}',
            },
          },
        ],
      },
      {
        id: "tool-result-1",
        role: "tool",
        toolCallId: "tool-1",
        content: "ok",
      },
    ]);
    expect(result.lastSeqOffset).toBe(3);
  });

  it("synthesizes failed results for unresolved tools on terminal errors", () => {
    const result = getDurableAgUiHistoryItemsFromEvents([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-open",
        toolCallName: "bash",
      } as BaseEvent,
      {
        type: EventType.RUN_ERROR,
        runId: "run-1",
        message: "Run failed",
      } as BaseEvent,
    ]);

    expect(result.items.at(-1)).toEqual({
      id: "tool-open:unresolved-result",
      role: "tool",
      toolCallId: "tool-open",
      content: "Run failed",
      error: "Run failed",
    });
    expect(result.lastSeqOffset).toBe(1);
  });
});
