import { describe, expect, it } from "vitest";
import {
  AssistantMessageEventSchema,
  ArtifactReferenceEventSchema,
  BaseEventEnvelopeSchema,
  CanonicalEventSchema,
  EVENT_ENVELOPE_VERSION,
  MetaEventSchema,
  OperationalRunStartedEventSchema,
  PermissionResponseEventSchema,
  SeqSchema,
  ThreadChatIdSchema,
  ThreadIdSchema,
  TimestampSchema,
  PermissionRequestEventSchema,
  ReasoningMessageEventSchema,
  ToolCallProgressEventSchema,
  ToolCallResultEventSchema,
  ToolCallStartEventSchema,
  UnknownProviderEventSchema,
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

const envelopeWithoutIdempotencyKey = {
  payloadVersion: EVENT_ENVELOPE_VERSION,
  eventId: "event-1",
  runId: "run-1",
  threadId: "thread-1",
  threadChatId: "thread-chat-1",
  seq: 0,
  timestamp: "2026-04-17T12:00:00.000Z",
};

describe("canonical-events", () => {
  it("parses a valid base envelope", () => {
    expect(BaseEventEnvelopeSchema.parse(baseEnvelope)).toEqual(baseEnvelope);
  });

  it("parses a canonical envelope without idempotencyKey", () => {
    expect(
      BaseEventEnvelopeSchema.parse(envelopeWithoutIdempotencyKey),
    ).toEqual(envelopeWithoutIdempotencyKey);
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
      ToolCallProgressEventSchema.parse({
        ...baseEnvelope,
        category: "tool_lifecycle",
        type: "tool-call-progress",
        toolCallId: "tool-1",
        delta: "streamed output",
        progressKind: "stdout",
      }),
    ).toEqual({
      ...baseEnvelope,
      category: "tool_lifecycle",
      type: "tool-call-progress",
      toolCallId: "tool-1",
      delta: "streamed output",
      progressKind: "stdout",
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

    expect(
      ReasoningMessageEventSchema.parse({
        ...baseEnvelope,
        category: "reasoning",
        type: "reasoning-message",
        messageId: "reasoning-1",
        content: "Thinking",
      }),
    ).toEqual({
      ...baseEnvelope,
      category: "reasoning",
      type: "reasoning-message",
      messageId: "reasoning-1",
      content: "Thinking",
    });

    expect(
      PermissionRequestEventSchema.parse({
        ...baseEnvelope,
        category: "permission",
        type: "permission-request",
        permissionRequestId: "permission-1",
        toolCallId: "tool-1",
        title: "Allow command?",
        options: ["approve", "deny"],
      }),
    ).toEqual({
      ...baseEnvelope,
      category: "permission",
      type: "permission-request",
      permissionRequestId: "permission-1",
      toolCallId: "tool-1",
      title: "Allow command?",
      options: ["approve", "deny"],
    });

    expect(
      PermissionResponseEventSchema.parse({
        ...baseEnvelope,
        category: "permission",
        type: "permission-response",
        permissionRequestId: "permission-1",
        response: "approved",
      }),
    ).toEqual({
      ...baseEnvelope,
      category: "permission",
      type: "permission-response",
      permissionRequestId: "permission-1",
      response: "approved",
    });

    expect(
      ArtifactReferenceEventSchema.parse({
        ...baseEnvelope,
        category: "artifact",
        type: "artifact-reference",
        artifactId: "artifact-1",
        artifactType: "diff",
        title: "Patch",
        uri: "r2://bucket/key",
        status: "ready",
      }),
    ).toEqual({
      ...baseEnvelope,
      category: "artifact",
      type: "artifact-reference",
      artifactId: "artifact-1",
      artifactType: "diff",
      title: "Patch",
      uri: "r2://bucket/key",
      status: "ready",
    });

    expect(
      MetaEventSchema.parse({
        ...baseEnvelope,
        category: "meta",
        type: "meta",
        name: "model-reroute",
        value: { from: "sonnet", to: "gpt-5.4" },
      }),
    ).toEqual({
      ...baseEnvelope,
      category: "meta",
      type: "meta",
      name: "model-reroute",
      value: { from: "sonnet", to: "gpt-5.4" },
    });

    expect(
      UnknownProviderEventSchema.parse({
        ...baseEnvelope,
        category: "quarantine",
        type: "unknown-provider-event",
        provider: "acp",
        reason: "unsupported event kind",
        rawEventType: "provider.experimental",
        redactedPayload: { token: "[REDACTED]" },
      }),
    ).toEqual({
      ...baseEnvelope,
      category: "quarantine",
      type: "unknown-provider-event",
      provider: "acp",
      reason: "unsupported event kind",
      rawEventType: "provider.experimental",
      redactedPayload: { token: "[REDACTED]" },
    });
  });

  it("rejects invalid canonical event shapes", () => {
    expect(() =>
      BaseEventEnvelopeSchema.parse({
        ...baseEnvelope,
        unexpectedTopLevelField: "nope",
      }),
    ).toThrow();

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

  it("rejects full daemon request bodies that are not canonical envelopes", () => {
    expect(() =>
      BaseEventEnvelopeSchema.parse({
        ...envelopeWithoutIdempotencyKey,
        messages: [],
        timezone: "America/Denver",
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
