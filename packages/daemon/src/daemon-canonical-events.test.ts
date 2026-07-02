import { createHash } from "node:crypto";
import { CanonicalEventSchema } from "@terragon/agent/canonical-events";
import { describe, expect, it, vi } from "vitest";
import {
  buildCanonicalEventsForBatch,
  type BuildCanonicalEventsParams,
  deriveRunTerminalFromMessages,
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
    canonicalTerminalEmitted: false,
    threadId: "thread-1",
    threadChatId: "thread-chat-1",
    timezone: "UTC",
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

  it("emits a completed run-terminal as the last event for a success result", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        canonicalRunStartedEmitted: true,
        nextCanonicalSeq: 4,
        messages: [
          {
            type: "assistant",
            message: { role: "assistant", content: "All done" },
            parent_tool_use_id: null,
            session_id: "session-1",
          },
          {
            type: "result",
            subtype: "success",
            total_cost_usd: 0,
            duration_ms: 10,
            duration_api_ms: 10,
            is_error: false,
            num_turns: 1,
            result: "ok",
            session_id: "session-1",
          },
        ],
      }),
    );
    expect(result.canonicalEvents).toEqual([
      expect.objectContaining({
        seq: 4,
        type: "assistant-message",
        content: "All done",
      }),
      expect.objectContaining({
        eventId: canonicalEventId("run-1", 5),
        seq: 5,
        category: "operational",
        type: "run-terminal",
        status: "completed",
      }),
    ]);
    const terminal = result.canonicalEvents.at(-1)!;
    expect("errorMessage" in terminal).toBe(false);
    expect(result.nextCanonicalSeqAfterBatch).toBe(6);
    expect(result.canonicalTerminalEmittedAfterBatch).toBe(true);
    expect(CanonicalEventSchema.parse(terminal)).toMatchObject({
      type: "run-terminal",
      status: "completed",
    });
  });

  it("maps an is_error result to a failed run-terminal carrying error text", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        canonicalRunStartedEmitted: true,
        messages: [
          {
            type: "result",
            is_error: true,
            subtype: "error_during_execution",
            duration_ms: 5,
            num_turns: 1,
            error: "boom",
            session_id: "session-1",
          },
        ],
      }),
    );
    expect(result.canonicalEvents).toEqual([
      expect.objectContaining({
        type: "run-terminal",
        status: "failed",
        errorMessage: "boom",
      }),
    ]);
    expect(result.canonicalTerminalEmittedAfterBatch).toBe(true);
  });

  it("maps custom-stop to a stopped run-terminal", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        canonicalRunStartedEmitted: true,
        messages: [{ type: "custom-stop", session_id: null, duration_ms: 3 }],
      }),
    );
    expect(result.canonicalEvents).toEqual([
      expect.objectContaining({ type: "run-terminal", status: "stopped" }),
    ]);
    expect(result.canonicalEvents.at(-1)).not.toHaveProperty("errorMessage");
    expect(result.canonicalTerminalEmittedAfterBatch).toBe(true);
  });

  it("maps custom-error to a failed run-terminal with its error_info", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        canonicalRunStartedEmitted: true,
        messages: [
          {
            type: "custom-error",
            session_id: null,
            duration_ms: 3,
            error_info: "agent crashed",
          },
        ],
      }),
    );
    expect(result.canonicalEvents).toEqual([
      expect.objectContaining({
        type: "run-terminal",
        status: "failed",
        errorMessage: "agent crashed",
      }),
    ]);
    expect(result.canonicalTerminalEmittedAfterBatch).toBe(true);
  });

  it("does not emit a second run-terminal once one was already emitted", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        canonicalRunStartedEmitted: true,
        canonicalTerminalEmitted: true,
        nextCanonicalSeq: 9,
        messages: [{ type: "custom-stop", session_id: null, duration_ms: 1 }],
      }),
    );
    expect(result.canonicalEvents).toEqual([]);
    expect(result.nextCanonicalSeqAfterBatch).toBe(9);
    expect(result.canonicalTerminalEmittedAfterBatch).toBe(true);
  });

  it("places the run-terminal after a run-started in a single terminal batch", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        messages: [
          {
            type: "result",
            subtype: "success",
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: "ok",
            session_id: "session-1",
          },
        ],
      }),
    );
    expect(result.canonicalEvents.map((event) => event.type)).toEqual([
      "run-started",
      "run-terminal",
    ]);
    expect(result.canonicalRunStartedEmittedAfterBatch).toBe(true);
    expect(result.canonicalTerminalEmittedAfterBatch).toBe(true);
  });
});

describe("buildCanonicalEventsForBatch recoverable classification", () => {
  function terminalOf(result: ReturnType<typeof buildCanonicalEventsForBatch>) {
    return result.canonicalEvents.find(
      (event) => event.type === "run-terminal",
    ) as Extract<
      ReturnType<
        typeof buildCanonicalEventsForBatch
      >["canonicalEvents"][number],
      { type: "run-terminal" }
    >;
  }

  it("stamps a rate-limit terminal (Claude usage limit)", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        agent: "claudeCode",
        canonicalRunStartedEmitted: true,
        messages: [
          {
            type: "result",
            subtype: "success",
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: "Claude AI usage limit reached|1752350400",
            session_id: "session-1",
          },
        ],
      }),
    );
    const terminal = terminalOf(result);
    expect(terminal.status).toBe("completed");
    expect(terminal.recoverable).toEqual({
      kind: "rate-limit",
      retryAfterMs: expect.any(Number),
    });
  });

  it("stamps a rate-limit terminal (Codex usage limit)", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        agent: "codex",
        canonicalRunStartedEmitted: true,
        messages: [
          {
            type: "result",
            subtype: "success",
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: "You've hit your usage limit. Try again in 2 hours.",
            session_id: "session-1",
          },
        ],
      }),
    );
    const terminal = terminalOf(result);
    expect(terminal.recoverable?.kind).toBe("rate-limit");
    expect(terminal.recoverable?.retryAfterMs).toBeGreaterThan(0);
  });

  it("stamps an oauth-token-revoked terminal", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        agent: "claudeCode",
        canonicalRunStartedEmitted: true,
        messages: [
          {
            type: "result",
            subtype: "success",
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: true,
            num_turns: 1,
            result: "OAuth token revoked",
            session_id: "session-1",
          },
        ],
      }),
    );
    const terminal = terminalOf(result);
    expect(terminal.status).toBe("failed");
    expect(terminal.recoverable).toEqual({ kind: "oauth-token-revoked" });
  });

  it("stamps a context-exhausted terminal", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        agent: "claudeCode",
        canonicalRunStartedEmitted: true,
        messages: [
          {
            type: "result",
            subtype: "success",
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: true,
            num_turns: 1,
            result: "Prompt is too long",
            session_id: "session-1",
          },
        ],
      }),
    );
    const terminal = terminalOf(result);
    expect(terminal.status).toBe("failed");
    expect(terminal.recoverable).toEqual({ kind: "context-exhausted" });
  });

  it("leaves a non-recoverable terminal unstamped", () => {
    const result = buildCanonicalEventsForBatch(
      baseParams({
        agent: "claudeCode",
        canonicalRunStartedEmitted: true,
        messages: [
          {
            type: "result",
            subtype: "success",
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: "ok",
            session_id: "session-1",
          },
        ],
      }),
    );
    const terminal = terminalOf(result);
    expect(terminal.status).toBe("completed");
    expect(terminal).not.toHaveProperty("recoverable");
  });
});

describe("deriveRunTerminalFromMessages", () => {
  it("returns null when no terminal message is present", () => {
    expect(
      deriveRunTerminalFromMessages([
        {
          type: "assistant",
          message: { role: "assistant", content: "hi" },
          parent_tool_use_id: null,
          session_id: "session-1",
        },
      ]),
    ).toBeNull();
  });

  it("prefers the first terminal message in the batch", () => {
    expect(
      deriveRunTerminalFromMessages([
        { type: "custom-stop", session_id: null, duration_ms: 1 },
        {
          type: "custom-error",
          session_id: null,
          duration_ms: 1,
          error_info: "later",
        },
      ]),
    ).toEqual({ status: "stopped", errorMessage: null });
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
