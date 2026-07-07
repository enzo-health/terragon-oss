import { EventType, type BaseEvent } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import { applyAgUiEvent, foldAgUiEnvelopes } from "./apply-ag-ui-event";
import { projectTranscript } from "./project-transcript";
import {
  createInitialTranscriptState,
  type DiffItem,
  type ErrorItem,
  type PlanItem,
  type ReasoningItem,
  type TerminalItem,
  type TextItem,
  type ToolItem,
  type TranscriptEnvelope,
  type TranscriptItem,
  type TranscriptState,
} from "./transcript-item";

const RUN = "run-1";

function env(
  payload: BaseEvent,
  overrides: Partial<TranscriptEnvelope> = {},
): TranscriptEnvelope {
  return { payload, runId: RUN, ...overrides };
}

function fold(
  events: readonly BaseEvent[],
  base?: TranscriptState,
): TranscriptState {
  return foldAgUiEnvelopes(
    events.map((payload) => env(payload)),
    base,
  );
}

function itemByKey(state: TranscriptState, key: string): TranscriptItem {
  const item = state.items.find((candidate) => candidate.key === key);
  if (!item) throw new Error(`missing item ${key}`);
  return item;
}

const runStarted: BaseEvent = {
  type: EventType.RUN_STARTED,
  runId: RUN,
  threadId: "t",
} as BaseEvent;

describe("applyAgUiEvent run lifecycle", () => {
  it("tracks run started and completed status", () => {
    const state = fold([
      runStarted,
      { type: EventType.RUN_FINISHED, runId: RUN, threadId: "t" } as BaseEvent,
    ]);
    expect(state.runs[RUN]?.status).toBe("completed");
    expect(state.currentRunId).toBe(RUN);
  });

  it("marks stopped runs from result.stopped", () => {
    const state = fold([
      runStarted,
      {
        type: EventType.RUN_FINISHED,
        runId: RUN,
        threadId: "t",
        result: { stopped: true },
      } as BaseEvent,
    ]);
    expect(state.runs[RUN]?.status).toBe("stopped");
  });

  it("captures run error message", () => {
    const state = fold([
      runStarted,
      { type: EventType.RUN_ERROR, runId: RUN, message: "boom" } as BaseEvent,
    ]);
    expect(state.runs[RUN]?.status).toBe("error");
    expect(state.runs[RUN]?.errorMessage).toBe("boom");
  });
});

describe("applyAgUiEvent streaming assembly", () => {
  it("assembles text from START/CONTENT/CONTENT/END", () => {
    const state = fold([
      runStarted,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "Hello",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: " world",
      } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as BaseEvent,
    ]);
    const item = itemByKey(state, "text:m1") as TextItem;
    expect(item.text).toBe("Hello world");
    expect(item.streaming).toBe(false);
  });

  it("keeps streaming true until END", () => {
    const state = fold([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "x",
      } as BaseEvent,
    ]);
    expect((itemByKey(state, "text:m1") as TextItem).streaming).toBe(true);
  });

  it("tolerates CONTENT before START (out of order)", () => {
    const state = fold([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "orphan",
      } as BaseEvent,
    ]);
    expect((itemByKey(state, "text:m1") as TextItem).text).toBe("orphan");
  });

  it("assembles reasoning text", () => {
    const state = fold([
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "r1",
        role: "reasoning",
      } as BaseEvent,
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "r1",
        delta: "think ",
      } as BaseEvent,
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "r1",
        delta: "hard",
      } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1" } as BaseEvent,
    ]);
    const item = itemByKey(state, "reasoning:r1") as ReasoningItem;
    expect(item.text).toBe("think hard");
    expect(item.streaming).toBe(false);
  });

  it("treats THINKING_TEXT_MESSAGE_* as reasoning", () => {
    const state = fold([
      {
        type: EventType.THINKING_TEXT_MESSAGE_START,
        messageId: "r1",
      } as BaseEvent,
      {
        type: EventType.THINKING_TEXT_MESSAGE_CONTENT,
        messageId: "r1",
        delta: "hmm",
      } as BaseEvent,
      {
        type: EventType.THINKING_TEXT_MESSAGE_END,
        messageId: "r1",
      } as BaseEvent,
    ]);
    expect((itemByKey(state, "reasoning:r1") as ReasoningItem).text).toBe(
      "hmm",
    );
  });
});

describe("applyAgUiEvent tool calls", () => {
  const toolStream: BaseEvent[] = [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc1",
      toolCallName: "Bash",
    } as BaseEvent,
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tc1",
      delta: '{"command":',
    } as BaseEvent,
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tc1",
      delta: '"ls"}',
    } as BaseEvent,
    { type: EventType.TOOL_CALL_END, toolCallId: "tc1" } as BaseEvent,
    {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "tc1",
      messageId: "tc1",
      content: "file.txt",
    } as BaseEvent,
  ];

  it("assembles args, parses json, records result and success", () => {
    const state = fold(toolStream);
    const item = itemByKey(state, "tool:tc1") as ToolItem;
    expect(item.name).toBe("Bash");
    expect(item.argsText).toBe('{"command":"ls"}');
    expect(item.parsedArgs).toEqual({ command: "ls" });
    expect(item.result).toBe("file.txt");
    expect(item.status).toBe("success");
    expect(item.streamingArgs).toBe(false);
  });

  it("marks error results", () => {
    const state = fold([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "Bash",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "tc1",
        messageId: "tc1",
        content: "nope",
        role: "tool",
        isError: true,
      } as BaseEvent,
    ]);
    const item = itemByKey(state, "tool:tc1") as ToolItem;
    expect(item.isError).toBe(true);
    expect(item.status).toBe("error");
  });

  it("replaces result on repeated TOOL_CALL_RESULT (streamed output)", () => {
    const state = fold([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "Bash",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "tc1",
        messageId: "tc1",
        content: "line 1",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "tc1",
        messageId: "tc1",
        content: "line 1\nline 2",
      } as BaseEvent,
    ]);
    expect((itemByKey(state, "tool:tc1") as ToolItem).result).toBe(
      "line 1\nline 2",
    );
  });

  it("interleaves two concurrent tool calls", () => {
    const state = fold([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "a",
        toolCallName: "Read",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "b",
        toolCallName: "Grep",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "a",
        delta: "AAA",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "b",
        delta: "BBB",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "b",
        messageId: "b",
        content: "rb",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "a",
        messageId: "a",
        content: "ra",
      } as BaseEvent,
    ]);
    expect((itemByKey(state, "tool:a") as ToolItem).argsText).toBe("AAA");
    expect((itemByKey(state, "tool:b") as ToolItem).argsText).toBe("BBB");
    expect((itemByKey(state, "tool:a") as ToolItem).result).toBe("ra");
    expect((itemByKey(state, "tool:b") as ToolItem).result).toBe("rb");
  });

  it("finalizes unresolved tool calls on RUN_FINISHED", () => {
    const state = fold([
      runStarted,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "Bash",
      } as BaseEvent,
      { type: EventType.RUN_FINISHED, runId: RUN, threadId: "t" } as BaseEvent,
    ]);
    const item = itemByKey(state, "tool:tc1") as ToolItem;
    expect(item.status).toBe("error");
    expect(item.result).toBe("Tool call ended without a result.");
  });

  it("routes TOOL_CALL_CHUNK stdout to the result channel", () => {
    const state = fold([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "Bash",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc1",
        delta: "out",
        progressKind: "stdout",
      } as BaseEvent,
    ]);
    const item = itemByKey(state, "tool:tc1") as ToolItem;
    expect(item.result).toBe("out");
    expect(item.argsText).toBe("");
  });
});

describe("applyAgUiEvent dedupe and out-of-order tolerance", () => {
  it("dedupes by (runId, eventId)", () => {
    let state = createInitialTranscriptState();
    const event = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m1",
      delta: "x",
    } as BaseEvent;
    state = applyAgUiEvent(state, {
      payload: event,
      runId: RUN,
      eventId: "e1",
    });
    const afterFirst = state;
    state = applyAgUiEvent(state, {
      payload: event,
      runId: RUN,
      eventId: "e1",
    });
    expect(state).toBe(afterFirst);
    expect((itemByKey(state, "text:m1") as TextItem).text).toBe("x");
  });

  it("is idempotent for a duplicate TOOL_CALL_START without eventId", () => {
    const state = fold([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "Bash",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc1",
        delta: "X",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "Bash",
      } as BaseEvent,
    ]);
    expect((itemByKey(state, "tool:tc1") as ToolItem).argsText).toBe("X");
    expect(state.items.filter((i) => i.key === "tool:tc1")).toHaveLength(1);
  });

  it("no-ops when a replay prefix is redelivered with the same eventIds", () => {
    const stream = [
      { payload: runStarted, runId: RUN, eventId: "e0" },
      {
        payload: {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "m1",
          role: "assistant",
        } as BaseEvent,
        runId: RUN,
        eventId: "e1",
      },
      {
        payload: {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "m1",
          delta: "Hi",
        } as BaseEvent,
        runId: RUN,
        eventId: "e2",
      },
    ] satisfies TranscriptEnvelope[];
    let state = foldAgUiEnvelopes(stream);
    const afterLive = state;
    for (const overlap of stream) {
      state = applyAgUiEvent(state, overlap);
    }
    expect(state).toBe(afterLive);
    expect((itemByKey(state, "text:m1") as TextItem).text).toBe("Hi");
  });
});

describe("applyAgUiEvent MESSAGES_SNAPSHOT hydration", () => {
  const snapshot: BaseEvent = {
    type: EventType.MESSAGES_SNAPSHOT,
    messages: [
      { id: "u1", role: "user", content: "hello" },
      {
        id: "m1",
        role: "assistant",
        content: "hi there",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "Bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
      { id: "tr1", role: "tool", toolCallId: "tc1", content: "file.txt" },
    ],
  } as BaseEvent;

  it("hydrates user, assistant, and tool messages", () => {
    const state = fold([snapshot]);
    expect(itemByKey(state, "user:u1").kind).toBe("user");
    expect((itemByKey(state, "text:m1") as TextItem).text).toBe("hi there");
    const tool = itemByKey(state, "tool:tc1") as ToolItem;
    expect(tool.name).toBe("Bash");
    expect(tool.result).toBe("file.txt");
    expect(tool.status).toBe("success");
  });

  it("appends live events after a snapshot without duplicating", () => {
    const state = fold([
      snapshot,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m2",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m2",
        delta: "next",
      } as BaseEvent,
    ]);
    expect(state.items.filter((i) => i.key === "text:m1")).toHaveLength(1);
    expect((itemByKey(state, "text:m2") as TextItem).text).toBe("next");
  });

  it("clears items on a context-reset system message and adds a compaction item", () => {
    const reset: BaseEvent = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        {
          id: "side-effect-system:compact-result-1",
          role: "system",
          content: "compacted",
        },
      ],
    } as BaseEvent;
    const state = fold([snapshot, reset]);
    expect(state.items.some((i) => i.kind === "compaction")).toBe(true);
    expect(state.items.some((i) => i.key === "text:m1")).toBe(false);
  });
});

describe("applyAgUiEvent rich-part routing", () => {
  function dataPart(name: string, data: unknown, partIndex = 0): BaseEvent {
    return {
      type: EventType.CUSTOM,
      name: "terragon.data-part",
      value: { messageId: "m1", partIndex, name, data },
    } as BaseEvent;
  }

  it("routes terragon.diff to a diff item", () => {
    const state = fold([
      dataPart("terragon.diff", {
        filePath: "src/a.ts",
        newContent: "next",
        oldContent: "",
        unifiedDiff: "--- /dev/null\n+++ b/src/a.ts",
        status: "applied",
      }),
    ]);
    const item = itemByKey(state, "part:m1:0") as DiffItem;
    expect(item.kind).toBe("diff");
    expect(item.filePath).toBe("src/a.ts");
    expect(item.changeKind).toBe("created");
    expect(item.status).toBe("applied");
  });

  it("routes terragon.plan to a plan item", () => {
    const state = fold([
      dataPart("terragon.plan", {
        entries: [
          { content: "step 1", status: "completed", priority: "high" },
          { content: "step 2", status: "in_progress", priority: "low" },
        ],
      }),
    ]);
    const item = itemByKey(state, "part:m1:0") as PlanItem;
    expect(item.entries).toHaveLength(2);
    expect(item.entries[0]?.status).toBe("completed");
  });

  it("routes terragon.terminal to a terminal item", () => {
    const state = fold([
      dataPart("terragon.terminal", {
        terminalId: "term-1",
        chunks: [{ streamSeq: 0, kind: "stdout", text: "hi" }],
      }),
    ]);
    const item = itemByKey(state, "part:m1:0") as TerminalItem;
    expect(item.terminalId).toBe("term-1");
    expect(item.chunks[0]?.text).toBe("hi");
  });

  it("routes terragon.error to an error item", () => {
    const state = fold([dataPart("terragon.error", { message: "kaboom" })]);
    expect((itemByKey(state, "part:m1:0") as ErrorItem).message).toBe("kaboom");
  });

  it("routes terragon.image to an image item", () => {
    const state = fold([
      dataPart("terragon.image", { mimeType: "image/png", uri: "blob:x" }),
    ]);
    const item = itemByKey(state, "part:m1:0");
    expect(item.kind).toBe("image");
  });

  it("routes terragon.resource-link to an attachment item", () => {
    const state = fold([
      dataPart("terragon.resource-link", {
        name: "spec.pdf",
        uri: "https://x/y",
      }),
    ]);
    expect(itemByKey(state, "part:m1:0").kind).toBe("attachment");
  });

  it("folds an unknown rich-part name to a labeled unknown-part", () => {
    const state = fold([dataPart("terragon.sketch", { foo: 1 })]);
    const item = itemByKey(state, "part:m1:0");
    expect(item.kind).toBe("unknown-part");
    if (item.kind === "unknown-part") {
      expect(item.label).toContain("sketch");
    }
  });

  it("upserts a rich-part on redelivery instead of duplicating", () => {
    const state = fold([
      dataPart("terragon.plan", {
        entries: [{ content: "a", status: "pending" }],
      }),
      dataPart("terragon.plan", {
        entries: [{ content: "a", status: "completed" }],
      }),
    ]);
    expect(state.items.filter((i) => i.key === "part:m1:0")).toHaveLength(1);
    expect((itemByKey(state, "part:m1:0") as PlanItem).entries[0]?.status).toBe(
      "completed",
    );
  });
});

describe("applyAgUiEvent never drops unknowns", () => {
  it("folds an unknown CUSTOM event name to an unknown-part", () => {
    const state = fold([
      {
        type: EventType.CUSTOM,
        name: "codex.mystery",
        value: { a: 1 },
      } as BaseEvent,
    ]);
    const item = state.items.find((i) => i.kind === "unknown-part");
    expect(item).toBeDefined();
    expect(item?.kind === "unknown-part" && item.name).toBe("codex.mystery");
  });

  it("ignores known meta CUSTOM events (meta channel, not transcript)", () => {
    const state = fold([
      {
        type: EventType.CUSTOM,
        name: "thread.status_changed",
        value: {},
      } as BaseEvent,
      {
        type: EventType.CUSTOM,
        name: "x",
        value: { kind: "model.rerouted" },
      } as BaseEvent,
    ]);
    expect(state.items).toHaveLength(0);
  });

  it("ignores operational event types without creating items", () => {
    const state = fold([
      { type: EventType.STATE_DELTA } as BaseEvent,
      { type: EventType.STEP_STARTED } as BaseEvent,
    ]);
    expect(state.items).toHaveLength(0);
  });
});

describe("applyAgUiEvent versioning and identity", () => {
  it("bumps only the changed item version", () => {
    let state = createInitialTranscriptState();
    state = applyAgUiEvent(
      state,
      env({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      } as BaseEvent),
    );
    state = applyAgUiEvent(
      state,
      env({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "Bash",
      } as BaseEvent),
    );
    const toolVersion = state.versions["tool:tc1"];
    state = applyAgUiEvent(
      state,
      env({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "x",
      } as BaseEvent),
    );
    expect(state.versions["text:m1"]).toBeGreaterThan(1);
    expect(state.versions["tool:tc1"]).toBe(toolVersion);
  });

  it("returns the same state reference for an ignored event", () => {
    const state = fold([runStarted]);
    const next = applyAgUiEvent(
      state,
      env({ type: EventType.STEP_STARTED } as BaseEvent),
    );
    expect(next).toBe(state);
  });

  it("preserves insertion order in the normalized projection", () => {
    const state = fold([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "answer",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "Bash",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "tc1",
        messageId: "tc1",
        content: "ok",
      } as BaseEvent,
    ]);
    const projection = projectTranscript(state.items);
    expect(projection.assistantText.m1).toBe("answer");
    expect(projection.tools.tc1?.resultText).toBe("ok");
  });
});
