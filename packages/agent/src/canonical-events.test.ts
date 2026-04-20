import { describe, expect, it } from "vitest";
import {
  AssistantMessageEventSchema,
  BaseEventEnvelopeSchema,
  CanonicalEventSchema,
  EVENT_ENVELOPE_VERSION,
  OperationalRunStartedEventSchema,
  SeqSchema,
  ThreadChatIdSchema,
  ThreadIdSchema,
  TimestampSchema,
  ToolCallResultEventSchema,
  ToolCallStartEventSchema,
} from "./canonical-events";

const baseEnvelope = {
  payloadVersion: EVENT_ENVELOPE_VERSION,
  eventId: "event-1",
  runId: "run-1",
  threadId: "thread-1",
  threadChatId: "thread-chat-1",
  seq: 0,
  timestamp: "2026-04-17T12:00:00.000Z",
  idempotencyKey: "key-1",
};

describe("canonical-events", () => {
  it("parses a valid base envelope", () => {
    expect(BaseEventEnvelopeSchema.parse(baseEnvelope)).toEqual(baseEnvelope);
  });

  it("rejects negative seq values", () => {
    expect(() => SeqSchema.parse(-1)).toThrow();
  });

  it("parses representative canonical events", () => {
    expect(
      OperationalRunStartedEventSchema.parse({
        ...baseEnvelope,
        category: "operational",
        type: "run-started",
        agent: "codex",
        model: "gpt-5.4",
        transportMode: "codex-app-server",
        protocolVersion: 2,
      }),
    ).toMatchObject({
      ...baseEnvelope,
      category: "operational",
      type: "run-started",
      agent: "codex",
    });

    expect(
      AssistantMessageEventSchema.parse({
        ...baseEnvelope,
        category: "transcript",
        type: "assistant-message",
        messageId: "message-1",
        content: "Hello",
        model: "sonnet",
      }),
    ).toEqual({
      ...baseEnvelope,
      category: "transcript",
      type: "assistant-message",
      messageId: "message-1",
      content: "Hello",
      model: "sonnet",
    });

    expect(
      ToolCallStartEventSchema.parse({
        ...baseEnvelope,
        category: "tool_lifecycle",
        type: "tool-call-start",
        toolCallId: "tool-1",
        name: "Bash",
        parameters: { command: "ls" },
      }),
    ).toEqual({
      ...baseEnvelope,
      category: "tool_lifecycle",
      type: "tool-call-start",
      toolCallId: "tool-1",
      name: "Bash",
      parameters: { command: "ls" },
    });

    expect(
      ToolCallResultEventSchema.parse({
        ...baseEnvelope,
        category: "tool_lifecycle",
        type: "tool-call-result",
        toolCallId: "tool-1",
        result: "done",
        isError: false,
        completedAt: "2026-04-17T12:00:01.000Z",
      }),
    ).toEqual({
      ...baseEnvelope,
      category: "tool_lifecycle",
      type: "tool-call-result",
      toolCallId: "tool-1",
      result: "done",
      isError: false,
      completedAt: "2026-04-17T12:00:01.000Z",
    });
  });

  it("rejects invalid canonical event shapes", () => {
    expect(() =>
      CanonicalEventSchema.parse({
        ...baseEnvelope,
        category: "operational",
        type: "run-started",
        agent: "codex",
        transportMode: "not-a-mode",
        protocolVersion: 2,
      }),
    ).toThrow();

    expect(() =>
      CanonicalEventSchema.parse({
        ...baseEnvelope,
        category: "transcript",
        type: "assistant-message",
        messageId: "message-1",
        content: 123,
      }),
    ).toThrow();
  });

  it("keeps the primitive schemas practical", () => {
    expect(ThreadIdSchema.parse("thread-1")).toBe("thread-1");
    expect(ThreadChatIdSchema.parse("thread-chat-1")).toBe("thread-chat-1");
    expect(TimestampSchema.parse("2026-04-17T12:00:00.000Z")).toBe(
      "2026-04-17T12:00:00.000Z",
    );
  });
});
