import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildCanonicalEventsForBatch,
  type BuildCanonicalEventsParams,
  getMessageFingerprint,
} from "./daemon-canonical-events";
import type { ClaudeMessage } from "./shared";

type AssistantMessage = Extract<ClaudeMessage, { type: "assistant" }>;
type MessageContent = AssistantMessage["message"]["content"];

function baseParams(
  overrides: Partial<BuildCanonicalEventsParams> = {},
): BuildCanonicalEventsParams {
  return {
    runId: "run-1",
    agent: "codex",
    model: "gpt-5.4",
    transportMode: "acp",
    protocolVersion: 2,
    nextCanonicalSeq: 0,
    canonicalRunStartedEmitted: false,
    threadId: "thread-1",
    threadChatId: "thread-chat-1",
    messages: [],
    ...overrides,
  };
}

function canonicalEventId(runId: string, seq: number): string {
  return createHash("sha256").update(`${runId}:canonical:${seq}`).digest("hex");
}

describe("buildCanonicalEventsForBatch", () => {
  it("returns no events for an empty batch", () => {
    const result = buildCanonicalEventsForBatch(baseParams({ messages: [] }));
    expect(result.canonicalEvents).toEqual([]);
    expect(result.nextCanonicalSeqAfterBatch).toBe(0);
    expect(result.canonicalRunStartedEmittedAfterBatch).toBe(false);
  });

  it("returns no events when the agent is null", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        agent: null,
        nextCanonicalSeq: 5,
        canonicalRunStartedEmitted: true,
        messages: [
          {
            type: "assistant",
            message: { role: "assistant", content: "hi" },
            parent_tool_use_id: null,
            session_id: "session-1",
          },
        ],
      }),
    );
    expect(result.canonicalEvents).toEqual([]);
    expect(result.nextCanonicalSeqAfterBatch).toBe(5);
    expect(result.canonicalRunStartedEmittedAfterBatch).toBe(true);
  });

  it("emits run-started once then suppresses it on the next batch", () => {
    const first = buildCanonicalEventsForBatch(
      baseParams({
        messages: [
          {
            type: "assistant",
            message: { role: "assistant", content: "First batch" },
            parent_tool_use_id: null,
            session_id: "session-1",
          },
        ],
      }),
    );
    expect(first.canonicalEvents).toEqual([
      expect.objectContaining({
        eventId: canonicalEventId("run-1", 0),
        seq: 0,
        type: "run-started",
        agent: "codex",
        transportMode: "acp",
        protocolVersion: 2,
        model: "gpt-5.4",
      }),
      expect.objectContaining({
        seq: 1,
        type: "assistant-message",
        content: "First batch",
      }),
    ]);
    expect(first.nextCanonicalSeqAfterBatch).toBe(2);
    expect(first.canonicalRunStartedEmittedAfterBatch).toBe(true);

    const second = buildCanonicalEventsForBatch(
      baseParams({
        nextCanonicalSeq: first.nextCanonicalSeqAfterBatch,
        canonicalRunStartedEmitted: first.canonicalRunStartedEmittedAfterBatch,
        messages: [
          {
            type: "assistant",
            message: { role: "assistant", content: "Second batch" },
            parent_tool_use_id: null,
            session_id: "session-1",
          },
        ],
      }),
    );
    expect(second.canonicalEvents).toEqual([
      expect.objectContaining({
        type: "assistant-message",
        seq: 2,
        content: "Second batch",
      }),
    ]);
    expect(second.nextCanonicalSeqAfterBatch).toBe(3);
  });

  it("emits assistant-message text events from array content blocks", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        canonicalRunStartedEmitted: true,
        nextCanonicalSeq: 1,
        messages: [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Thinking out loud" }],
            },
            parent_tool_use_id: null,
            session_id: "session-1",
          },
        ],
      }),
    );
    expect(result.canonicalEvents).toEqual([
      expect.objectContaining({
        eventId: canonicalEventId("run-1", 1),
        seq: 1,
        type: "assistant-message",
        messageId: canonicalEventId("run-1", 1),
        content: "Thinking out loud",
      }),
    ]);
  });

  it("suppresses the assistant-message when _codexItemId is set", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        messages: [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Streamed via deltas" }],
            },
            parent_tool_use_id: null,
            session_id: "session-1",
            _codexItemId: "msg_abc123",
          },
        ],
      }),
    );
    // Only run-started — no assistant-message duplicate of the delta stream.
    expect(result.canonicalEvents).toEqual([
      expect.objectContaining({ type: "run-started" }),
    ]);
    expect(result.nextCanonicalSeqAfterBatch).toBe(1);
  });

  it("suppresses ACP text blocks already streamed as daemon deltas", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        messages: [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Streamed over ACP" }],
            },
            parent_tool_use_id: null,
            session_id: "session-1",
            _claudeStreamedBlockIndices: [0],
          },
        ],
      }),
    );

    expect(result.canonicalEvents).toEqual([
      expect.objectContaining({ type: "run-started" }),
    ]);
    expect(result.nextCanonicalSeqAfterBatch).toBe(1);
  });

  it("emits tool-call-start and tool-call-result events", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        canonicalRunStartedEmitted: true,
        nextCanonicalSeq: 0,
        messages: [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tool-call-1",
                  name: "bash",
                  input: { command: "pwd" },
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: "session-1",
          },
          {
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-call-1",
                  content: "pwd output",
                  is_error: false,
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: "session-1",
          },
        ],
      }),
    );
    expect(result.canonicalEvents).toEqual([
      expect.objectContaining({
        seq: 0,
        type: "tool-call-start",
        toolCallId: "tool-call-1",
        name: "bash",
        parameters: { command: "pwd" },
      }),
      expect.objectContaining({
        seq: 1,
        type: "tool-call-result",
        toolCallId: "tool-call-1",
        result: "pwd output",
        isError: false,
      }),
    ]);
  });

  it("invokes onMalformedBlock for tool blocks missing identity", () => {
    const onMalformedBlock = vi.fn();
    const result = buildCanonicalEventsForBatch(
      baseParams({
        canonicalRunStartedEmitted: true,
        onMalformedBlock,
        messages: [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "tool_use", input: {} }] as MessageContent,
            },
            parent_tool_use_id: null,
            session_id: "session-1",
          },
        ],
      }),
    );
    expect(result.canonicalEvents).toEqual([]);
    expect(onMalformedBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        threadId: "thread-1",
        threadChatId: "thread-chat-1",
        blockType: "tool_use",
        reason: "missing_tool_use_identity",
      }),
    );
  });
});

describe("getMessageFingerprint", () => {
  it("is stable for equal message arrays and differs for different ones", () => {
    const messages: ClaudeMessage[] = [
      {
        type: "assistant",
        message: { role: "assistant", content: "hello" },
        parent_tool_use_id: null,
        session_id: "session-1",
      },
    ];
    const other: ClaudeMessage[] = [
      {
        type: "assistant",
        message: { role: "assistant", content: "world" },
        parent_tool_use_id: null,
        session_id: "session-1",
      },
    ];
    expect(getMessageFingerprint(messages)).toBe(
      getMessageFingerprint(messages),
    );
    expect(getMessageFingerprint(messages)).not.toBe(
      getMessageFingerprint(other),
    );
    expect(getMessageFingerprint(messages)).toBe(
      createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
    );
  });
});
