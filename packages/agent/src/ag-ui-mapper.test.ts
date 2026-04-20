import { describe, expect, it } from "vitest";
import { EventType } from "@ag-ui/core";
import {
  mapCanonicalEventToAgui,
  mapDaemonDeltaToAgui,
  mapMetaEventToAgui,
  mapRunErrorToAgui,
  mapRunFinishedToAgui,
  serializeAgUiEvent,
} from "./ag-ui-mapper";
import {
  EVENT_ENVELOPE_VERSION,
  type AssistantMessageEvent,
  type OperationalRunStartedEvent,
  type ToolCallResultEvent as CanonicalToolCallResultEvent,
  type ToolCallStartEvent as CanonicalToolCallStartEvent,
} from "./canonical-events";

const baseEnvelope = {
  payloadVersion: EVENT_ENVELOPE_VERSION as 2,
  eventId: "event-1",
  runId: "run-1",
  threadId: "thread-1",
  threadChatId: "thread-chat-1",
  seq: 0,
  timestamp: "2026-04-17T12:00:00.000Z",
} as const;

describe("mapCanonicalEventToAgui", () => {
  describe("run-started", () => {
    it("maps to RUN_STARTED preserving threadId and runId", () => {
      const event: OperationalRunStartedEvent = {
        ...baseEnvelope,
        category: "operational",
        type: "run-started",
        agent: "claudeCode",
        transportMode: "legacy",
        protocolVersion: 2,
      };

      const result = mapCanonicalEventToAgui(event);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "run-1",
        timestamp: Date.parse("2026-04-17T12:00:00.000Z"),
      });
    });
  });

  describe("assistant-message", () => {
    it("emits START + CONTENT + END when content is non-empty", () => {
      const event: AssistantMessageEvent = {
        ...baseEnvelope,
        category: "transcript",
        type: "assistant-message",
        messageId: "msg-1",
        content: "Hello world",
      };

      const result = mapCanonicalEventToAgui(event);

      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-1",
        role: "assistant",
      });
      expect(result[1]).toMatchObject({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "Hello world",
      });
      expect(result[2]).toMatchObject({
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-1",
      });
    });

    it("emits only START + END when content is empty", () => {
      const event: AssistantMessageEvent = {
        ...baseEnvelope,
        category: "transcript",
        type: "assistant-message",
        messageId: "msg-empty",
        content: "",
      };

      const result = mapCanonicalEventToAgui(event);

      expect(result).toHaveLength(2);
      expect(result[0]?.type).toBe(EventType.TEXT_MESSAGE_START);
      expect(result[1]?.type).toBe(EventType.TEXT_MESSAGE_END);
    });
  });

  describe("tool-call-start", () => {
    it("emits START + ARGS + END with JSON-stringified parameters", () => {
      const event: CanonicalToolCallStartEvent = {
        ...baseEnvelope,
        category: "tool_lifecycle",
        type: "tool-call-start",
        toolCallId: "tc-1",
        name: "Bash",
        parameters: { command: "ls -la", description: "list files" },
      };

      const result = mapCanonicalEventToAgui(event);

      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-1",
        toolCallName: "Bash",
      });
      expect(result[1]).toMatchObject({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc-1",
      });
      const argsEvent = result[1] as unknown as { delta: string };
      expect(JSON.parse(argsEvent.delta)).toEqual({
        command: "ls -la",
        description: "list files",
      });
      expect(result[2]).toMatchObject({
        type: EventType.TOOL_CALL_END,
        toolCallId: "tc-1",
      });
    });

    it("sets parentMessageId when parentToolUseId is present", () => {
      const event: CanonicalToolCallStartEvent = {
        ...baseEnvelope,
        category: "tool_lifecycle",
        type: "tool-call-start",
        toolCallId: "tc-2",
        name: "Read",
        parameters: { file_path: "/tmp/x" },
        parentToolUseId: "parent-tool-1",
      };

      const result = mapCanonicalEventToAgui(event);

      expect(result[0]).toMatchObject({
        type: EventType.TOOL_CALL_START,
        parentMessageId: "parent-tool-1",
      });
    });

    it("handles empty parameters object", () => {
      const event: CanonicalToolCallStartEvent = {
        ...baseEnvelope,
        category: "tool_lifecycle",
        type: "tool-call-start",
        toolCallId: "tc-3",
        name: "NoArgs",
        parameters: {},
      };

      const result = mapCanonicalEventToAgui(event);

      const argsEvent = result[1] as unknown as { delta: string };
      expect(argsEvent.delta).toBe("{}");
    });
  });

  describe("tool-call-result", () => {
    it("maps to TOOL_CALL_RESULT with content string", () => {
      const event: CanonicalToolCallResultEvent = {
        ...baseEnvelope,
        category: "tool_lifecycle",
        type: "tool-call-result",
        toolCallId: "tc-1",
        result: "output text here",
        isError: false,
        completedAt: "2026-04-17T12:00:01.000Z",
      };

      const result = mapCanonicalEventToAgui(event);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "tc-1",
        content: "output text here",
      });
    });

    it("preserves error result string (client decides rendering)", () => {
      const event: CanonicalToolCallResultEvent = {
        ...baseEnvelope,
        category: "tool_lifecycle",
        type: "tool-call-result",
        toolCallId: "tc-err",
        result: "permission denied",
        isError: true,
        completedAt: "2026-04-17T12:00:01.000Z",
      };

      const result = mapCanonicalEventToAgui(event);

      expect(result[0]).toMatchObject({
        type: EventType.TOOL_CALL_RESULT,
        content: "permission denied",
      });
    });
  });
});

describe("mapDaemonDeltaToAgui", () => {
  it("maps text delta to TEXT_MESSAGE_CONTENT", () => {
    const result = mapDaemonDeltaToAgui(
      {
        messageId: "m-1",
        partIndex: 0,
        deltaSeq: 5,
        kind: "text",
        text: "Hello",
      },
      1_700_000_000_000,
    );

    expect(result).toMatchObject({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m-1",
      delta: "Hello",
      timestamp: 1_700_000_000_000,
    });
  });

  it("defaults missing kind to text", () => {
    const result = mapDaemonDeltaToAgui({
      messageId: "m-2",
      partIndex: 0,
      deltaSeq: 1,
      text: "chunk",
    });

    expect(result.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
  });

  it("maps thinking delta to REASONING_MESSAGE_CONTENT", () => {
    const result = mapDaemonDeltaToAgui({
      messageId: "m-3",
      partIndex: 0,
      deltaSeq: 1,
      kind: "thinking",
      text: "let me consider...",
    });

    expect(result.type).toBe(EventType.REASONING_MESSAGE_CONTENT);
    expect(result).toMatchObject({
      messageId: "m-3",
      delta: "let me consider...",
    });
  });
});

describe("mapMetaEventToAgui", () => {
  it("wraps meta event in CUSTOM with kind as name", () => {
    const meta = {
      kind: "thread.token_usage_updated",
      threadId: "t-1",
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
    };

    const result = mapMetaEventToAgui(meta, 42);

    expect(result).toMatchObject({
      type: EventType.CUSTOM,
      name: "thread.token_usage_updated",
      value: meta,
      timestamp: 42,
    });
  });

  it("handles meta events with arbitrary kinds", () => {
    const result = mapMetaEventToAgui({ kind: "x.custom.thing", foo: "bar" });

    expect(result.name).toBe("x.custom.thing");
    expect(result.value).toEqual({ kind: "x.custom.thing", foo: "bar" });
  });
});

describe("mapRunFinishedToAgui", () => {
  it("emits RUN_FINISHED on success", () => {
    const result = mapRunFinishedToAgui("thread-1", "run-1", false, 123);

    expect(result).toMatchObject({
      type: EventType.RUN_FINISHED,
      threadId: "thread-1",
      runId: "run-1",
      timestamp: 123,
    });
    expect(result).not.toHaveProperty("result");
  });

  it("includes stopped marker when run was cancelled", () => {
    const result = mapRunFinishedToAgui("thread-1", "run-1", true);

    expect((result as { result: { stopped: boolean } }).result).toEqual({
      stopped: true,
    });
  });
});

describe("mapRunErrorToAgui", () => {
  it("emits RUN_ERROR with just message", () => {
    const result = mapRunErrorToAgui("daemon crashed");

    expect(result).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "daemon crashed",
    });
    expect(result).not.toHaveProperty("code");
  });

  it("includes code when provided", () => {
    const result = mapRunErrorToAgui("rate limited", "RATE_LIMIT");

    expect(result).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "rate limited",
      code: "RATE_LIMIT",
    });
  });
});

describe("serializeAgUiEvent", () => {
  it("produces JSON-stringified output suitable for SSE data frames", () => {
    const event = mapRunFinishedToAgui("t", "r", false, 1);
    const serialized = serializeAgUiEvent(event);

    expect(() => JSON.parse(serialized)).not.toThrow();
    const parsed = JSON.parse(serialized);
    expect(parsed.type).toBe(EventType.RUN_FINISHED);
  });
});
