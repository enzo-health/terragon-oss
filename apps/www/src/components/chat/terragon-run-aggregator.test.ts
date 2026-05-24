import { EventType, type AGUIEvent } from "@ag-ui/core";
import type { ChatModelRunResult } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import { TerragonRunAggregator } from "./terragon-run-aggregator";

describe("TerragonRunAggregator", () => {
  it("keeps tool progress separate from streamed arguments", () => {
    const updates: ChatModelRunResult[] = [];
    const aggregator = new TerragonRunAggregator({
      showThinking: true,
      logger: {},
      emit: (update) => updates.push(update),
    });

    aggregator.handle({ type: "RUN_STARTED", runId: "run-1" });
    aggregator.handle({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool-1",
      toolCallName: "Bash",
      parentMessageId: "assistant-1",
    } as AGUIEvent);
    aggregator.handle({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool-1",
      delta: '{"command":"pnpm test"}',
    } as AGUIEvent);
    aggregator.handle({
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: "tool-1",
      delta: "running tests\n",
    } as AGUIEvent);
    aggregator.handle({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool-1",
    } as AGUIEvent);

    expect(updates.at(-1)?.content).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolCallId: "tool-1",
        argsText: '{"command":"pnpm test"}',
        args: { command: "pnpm test" },
        toolStatus: "in_progress",
        progressChunks: [{ seq: 1, text: "running tests\n" }],
      }),
    ]);
  });

  it("waits for complete streamed tool arguments before publishing parsed args", () => {
    const updates: ChatModelRunResult[] = [];
    const aggregator = new TerragonRunAggregator({
      showThinking: true,
      logger: {},
      emit: (update) => updates.push(update),
    });

    aggregator.handle({ type: "RUN_STARTED", runId: "run-1" });
    aggregator.handle({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool-1",
      toolCallName: "Bash",
      parentMessageId: "assistant-1",
    } as AGUIEvent);
    aggregator.handle({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool-1",
      delta: '{"command":',
    } as AGUIEvent);
    aggregator.handle({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool-1",
    } as AGUIEvent);

    expect(updates.at(-1)?.content).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolCallId: "tool-1",
        argsText: '{"command":',
        args: {},
      }),
    ]);

    aggregator.handle({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool-1",
      delta: '"pnpm test"}',
    } as AGUIEvent);
    aggregator.handle({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool-1",
    } as AGUIEvent);

    expect(updates.at(-1)?.content).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolCallId: "tool-1",
        argsText: '{"command":"pnpm test"}',
        args: { command: "pnpm test" },
      }),
    ]);
  });

  it("bounds retained progress chunks before emitting runtime parts", () => {
    const updates: ChatModelRunResult[] = [];
    const aggregator = new TerragonRunAggregator({
      showThinking: true,
      logger: {},
      emit: (update) => updates.push(update),
    });

    aggregator.handle({ type: "RUN_STARTED", runId: "run-1" });
    aggregator.handle({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool-1",
      toolCallName: "Bash",
      parentMessageId: "assistant-1",
    } as AGUIEvent);
    for (let index = 0; index < 55; index += 1) {
      aggregator.handle({
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tool-1",
        delta: `chunk ${index}`,
      } as AGUIEvent);
    }
    aggregator.handle({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool-1",
    } as AGUIEvent);

    expect(updates.at(-1)?.content).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolCallId: "tool-1",
        progressHiddenCount: 5,
        progressChunks: expect.arrayContaining([
          { seq: 6, text: "chunk 5" },
          { seq: 55, text: "chunk 54" },
        ]),
      }),
    ]);
    const toolPart = updates.at(-1)?.content?.[0];
    expect(
      toolPart && "progressChunks" in toolPart ? toolPart.progressChunks : null,
    ).toHaveLength(50);
  });

  it("marks unresolved tools as failed when the run ends", () => {
    const updates: ChatModelRunResult[] = [];
    const aggregator = new TerragonRunAggregator({
      showThinking: true,
      logger: {},
      emit: (update) => updates.push(update),
    });

    aggregator.handle({ type: "RUN_STARTED", runId: "run-1" });
    aggregator.handle({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool-1",
      toolCallName: "Bash",
      parentMessageId: "assistant-1",
    } as AGUIEvent);
    aggregator.handle({ type: "RUN_ERROR", message: "boom" });

    expect(updates.at(-1)?.content).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolCallId: "tool-1",
        isError: true,
        result: "boom",
      }),
    ]);
  });

  it("preserves a completed null tool result", () => {
    const updates: ChatModelRunResult[] = [];
    const aggregator = new TerragonRunAggregator({
      showThinking: true,
      logger: {},
      emit: (update) => updates.push(update),
    });

    aggregator.handle({ type: "RUN_STARTED", runId: "run-1" });
    aggregator.handle({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool-1",
      toolCallName: "Bash",
      parentMessageId: "assistant-1",
    } as AGUIEvent);
    aggregator.handle({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "tool-1",
      content: null,
    } as unknown as AGUIEvent);

    expect(updates.at(-1)?.content).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolCallId: "tool-1",
        result: null,
      }),
    ]);
  });
});
