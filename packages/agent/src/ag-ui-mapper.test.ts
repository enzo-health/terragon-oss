import { describe, expect, it } from "vitest";
import { EventType } from "@ag-ui/core";
import {
  dbAgentMessagePartsToAgUi,
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
  type ArtifactReferenceEvent,
  type MetaEvent as CanonicalMetaEvent,
  type OperationalRunStartedEvent,
  type PermissionRequestEvent,
  type PermissionResponseEvent,
  type ReasoningMessageEvent,
  type ToolCallProgressEvent as CanonicalToolCallProgressEvent,
  type ToolCallResultEvent as CanonicalToolCallResultEvent,
  type ToolCallStartEvent as CanonicalToolCallStartEvent,
  type UnknownProviderEvent,
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

const baseIdentity = {
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

  describe("tool-call-progress", () => {
    it("maps to TOOL_CALL_CHUNK", () => {
      const event: CanonicalToolCallProgressEvent = {
        ...baseEnvelope,
        category: "tool_lifecycle",
        type: "tool-call-progress",
        toolCallId: "tc-1",
        delta: "stdout chunk",
        progressKind: "stdout",
      };

      const result = mapCanonicalEventToAgui(event);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc-1",
        delta: "stdout chunk",
        progressKind: "stdout",
      });
    });
  });

  describe("reasoning-message", () => {
    it("emits reasoning START + CONTENT + END", () => {
      const event: ReasoningMessageEvent = {
        ...baseEnvelope,
        category: "reasoning",
        type: "reasoning-message",
        messageId: "reasoning-1",
        content: "I should inspect the route first.",
      };

      const result = mapCanonicalEventToAgui(event);

      expect(result.map((entry) => entry.type)).toEqual([
        EventType.REASONING_MESSAGE_START,
        EventType.REASONING_MESSAGE_CONTENT,
        EventType.REASONING_MESSAGE_END,
      ]);
      expect(result[1]).toMatchObject({
        messageId: "reasoning-1",
        delta: "I should inspect the route first.",
      });
    });
  });

  describe("custom projection events", () => {
    it("maps permission requests to CUSTOM events", () => {
      const event: PermissionRequestEvent = {
        ...baseEnvelope,
        category: "permission",
        type: "permission-request",
        permissionRequestId: "permission-1",
        toolCallId: "tc-1",
        title: "Run command?",
        options: ["approve", "deny"],
      };

      const result = mapCanonicalEventToAgui(event);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: EventType.CUSTOM,
        name: "permission-request",
        value: {
          ...baseIdentity,
          permissionRequestId: "permission-1",
          toolCallId: "tc-1",
          title: "Run command?",
          options: ["approve", "deny"],
        },
      });
    });

    it("maps permission responses to CUSTOM events", () => {
      const event: PermissionResponseEvent = {
        ...baseEnvelope,
        category: "permission",
        type: "permission-response",
        permissionRequestId: "permission-1",
        response: "approved",
      };

      const result = mapCanonicalEventToAgui(event);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: EventType.CUSTOM,
        name: "permission-response",
        value: {
          ...baseIdentity,
          permissionRequestId: "permission-1",
          response: "approved",
        },
      });
    });

    it("maps artifact references to CUSTOM events", () => {
      const event: ArtifactReferenceEvent = {
        ...baseEnvelope,
        category: "artifact",
        type: "artifact-reference",
        artifactId: "artifact-1",
        artifactType: "diff",
        title: "Patch",
        uri: "r2://bucket/key",
        status: "ready",
      };

      const result = mapCanonicalEventToAgui(event);

      expect(result[0]).toMatchObject({
        type: EventType.CUSTOM,
        name: "artifact-reference",
        value: {
          ...baseIdentity,
          artifactId: "artifact-1",
          artifactType: "diff",
          title: "Patch",
          uri: "r2://bucket/key",
          status: "ready",
        },
      });
    });

    it("maps meta events using their meta name", () => {
      const event: CanonicalMetaEvent = {
        ...baseEnvelope,
        category: "meta",
        type: "meta",
        name: "model-reroute",
        value: { from: "sonnet", to: "gpt-5.4" },
      };

      const result = mapCanonicalEventToAgui(event);

      expect(result[0]).toMatchObject({
        type: EventType.CUSTOM,
        name: "model-reroute",
        value: {
          ...baseIdentity,
          from: "sonnet",
          to: "gpt-5.4",
        },
      });
    });
  });

  describe("unknown-provider-event", () => {
    it("does not render quarantined provider payloads by default", () => {
      const event: UnknownProviderEvent = {
        ...baseEnvelope,
        category: "quarantine",
        type: "unknown-provider-event",
        provider: "acp",
        reason: "unsupported event kind",
        redactedPayload: { token: "[REDACTED]" },
      };

      expect(mapCanonicalEventToAgui(event)).toEqual([]);
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

describe("dbAgentMessagePartsToAgUi", () => {
  const MSG = "m-agent-1";
  const TS = 1_712_000_000_000;

  it("returns empty array when parts contain only text", () => {
    const result = dbAgentMessagePartsToAgUi(
      MSG,
      [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
      TS,
    );
    expect(result).toEqual([]);
  });

  it("skips tool-use and tool-result parts (covered by canonical events)", () => {
    const result = dbAgentMessagePartsToAgUi(
      MSG,
      [
        { type: "tool-use", id: "tc-1", name: "Bash", input: {} },
        {
          type: "tool-result",
          id: "tc-1",
          is_error: false,
          result: "ok",
          parent_tool_use_id: null,
        },
      ],
      TS,
    );
    expect(result).toEqual([]);
  });

  it("expands a thinking part to REASONING_MESSAGE_START + CONTENT + END", () => {
    const result = dbAgentMessagePartsToAgUi(
      MSG,
      [{ type: "thinking", thinking: "let me think..." }],
      TS,
    );
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "m-agent-1:thinking:0",
      role: "reasoning",
      timestamp: TS,
    });
    expect(result[1]).toMatchObject({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "m-agent-1:thinking:0",
      delta: "let me think...",
      timestamp: TS,
    });
    expect(result[2]).toMatchObject({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "m-agent-1:thinking:0",
      timestamp: TS,
    });
  });

  it("omits the CONTENT event for an empty thinking part (still emits START + END)", () => {
    const result = dbAgentMessagePartsToAgUi(
      MSG,
      [{ type: "thinking", thinking: "" }],
      TS,
    );
    expect(result.map((e) => e.type)).toEqual([
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_END,
    ]);
  });

  it("encodes a terminal part as a CUSTOM event with name terragon.part.terminal", () => {
    const terminalPart = {
      type: "terminal",
      sandboxId: "sb-1",
      terminalId: "term-1",
      chunks: [{ streamSeq: 0, kind: "stdout", text: "hi" }],
    };
    const result = dbAgentMessagePartsToAgUi(MSG, [terminalPart], TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: EventType.CUSTOM,
      name: "terragon.part.terminal",
      timestamp: TS,
      value: {
        messageId: MSG,
        partIndex: 0,
        part: terminalPart,
      },
    });
  });

  it("emits CUSTOM events in order across a mixed part array, preserving partIndex", () => {
    const thinking = { type: "thinking", thinking: "brief" };
    const terminal = {
      type: "terminal",
      sandboxId: "sb",
      terminalId: "t",
      chunks: [],
    };
    const diff = {
      type: "diff",
      filePath: "a.ts",
      newContent: "x",
      status: "pending",
    };
    const result = dbAgentMessagePartsToAgUi(
      MSG,
      [
        { type: "text", text: "pre" },
        thinking,
        { type: "text", text: "middle" },
        terminal,
        diff,
      ],
      TS,
    );

    // Expected expansion (by source partIndex):
    //   0: text -> skipped
    //   1: thinking -> 3 reasoning events
    //   2: text -> skipped
    //   3: terminal -> 1 custom event (partIndex: 3)
    //   4: diff -> 1 custom event (partIndex: 4)
    expect(result).toHaveLength(5);
    expect(result[0]?.type).toBe(EventType.REASONING_MESSAGE_START);
    expect(result[1]?.type).toBe(EventType.REASONING_MESSAGE_CONTENT);
    expect(result[2]?.type).toBe(EventType.REASONING_MESSAGE_END);
    expect(result[3]).toMatchObject({
      type: EventType.CUSTOM,
      name: "terragon.part.terminal",
      value: { messageId: MSG, partIndex: 3, part: terminal },
    });
    expect(result[4]).toMatchObject({
      type: EventType.CUSTOM,
      name: "terragon.part.diff",
      value: { messageId: MSG, partIndex: 4, part: diff },
    });
  });

  it.each([
    [
      "terminal",
      { type: "terminal", sandboxId: "s", terminalId: "t", chunks: [] },
    ],
    [
      "diff",
      { type: "diff", filePath: "a", newContent: "b", status: "pending" },
    ],
    [
      "image",
      { type: "image", mime_type: "image/png", image_url: "https://x" },
    ],
    ["audio", { type: "audio", mimeType: "audio/wav" }],
    [
      "pdf",
      { type: "pdf", mime_type: "application/pdf", pdf_url: "https://x" },
    ],
    [
      "text-file",
      { type: "text-file", mime_type: "text/plain", file_url: "https://x" },
    ],
    ["resource-link", { type: "resource-link", uri: "https://x", name: "n" }],
    [
      "auto-approval-review",
      {
        type: "auto-approval-review",
        reviewId: "r",
        targetItemId: "t",
        riskLevel: "low",
        action: "write",
        status: "pending",
      },
    ],
    ["plan", { type: "plan", entries: [] }],
    [
      "plan-structured",
      { type: "plan-structured", entries: [], title: "Plan" },
    ],
    [
      "server-tool-use",
      { type: "server-tool-use", id: "s1", name: "web_search", input: {} },
    ],
    [
      "web-search-result",
      { type: "web-search-result", toolUseId: "s1", results: [] },
    ],
    ["rich-text", { type: "rich-text", nodes: [{ type: "text", text: "x" }] }],
  ])(
    "wraps %s as CUSTOM terragon.part.%s with full part in value",
    (name, part) => {
      const result = dbAgentMessagePartsToAgUi(MSG, [part], TS);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: EventType.CUSTOM,
        name: `terragon.part.${name}`,
        timestamp: TS,
        value: { messageId: MSG, partIndex: 0, part },
      });
    },
  );
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
