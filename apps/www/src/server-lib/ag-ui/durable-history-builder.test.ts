import {
  type BaseEvent,
  EventType,
  type Message,
  type RunFinishedEvent,
  type RunStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
  type ToolMessage,
} from "@ag-ui/core";
import { describe, expect, it } from "vitest";

import { getDurableAgUiHistoryItemsFromEvents } from "./durable-history-builder";

const toolStart = (toolCallId: string): BaseEvent =>
  ({
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: "Bash",
    parentMessageId: "asst-1",
  }) as ToolCallStartEvent;

const toolResult = (
  toolCallId: string,
  content: string,
  role?: "tool",
): BaseEvent =>
  ({
    type: EventType.TOOL_CALL_RESULT,
    messageId: toolCallId,
    toolCallId,
    content,
    ...(role ? { role } : {}),
  }) as ToolCallResultEvent;

const textStart = (messageId: string): BaseEvent =>
  ({
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role: "assistant",
  }) satisfies TextMessageStartEvent;

const textContent = (messageId: string, delta: string): BaseEvent =>
  ({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta,
  }) satisfies TextMessageContentEvent;

const textEnd = (messageId: string): BaseEvent =>
  ({
    type: EventType.TEXT_MESSAGE_END,
    messageId,
  }) satisfies TextMessageEndEvent;

const runStarted = (): BaseEvent =>
  ({
    type: EventType.RUN_STARTED,
    threadId: "thread-acp-stream",
    runId: "run-acp-stream",
  }) satisfies RunStartedEvent;

const runFinished = (): BaseEvent =>
  ({
    type: EventType.RUN_FINISHED,
    threadId: "thread-acp-stream",
    runId: "run-acp-stream",
  }) satisfies RunFinishedEvent;

const assistantHistoryRows = (
  items: ReturnType<typeof getDurableAgUiHistoryItemsFromEvents>["items"],
): Extract<Message, { role: "assistant" }>[] =>
  items.filter(
    (item): item is Extract<Message, { role: "assistant" }> =>
      "role" in item && item.role === "assistant",
  );

const toolHistoryRows = (
  items: ReturnType<typeof getDurableAgUiHistoryItemsFromEvents>["items"],
  toolCallId: string,
): ToolMessage[] =>
  items.filter(
    (item): item is ToolMessage =>
      "role" in item && item.role === "tool" && item.toolCallId === toolCallId,
  );

describe("getDurableAgUiHistoryItemsFromEvents tool-output collapse", () => {
  it("collapses repeated cumulative TOOL_CALL_RESULT events for one tool into a single last-wins row", () => {
    // Codex command output streams as repeated cumulative TOOL_CALL_RESULT
    // events (the live mapper routes tool-output here), capped by the terminal
    // result. The resume history must carry one tool-result row, not one per chunk.
    const events: BaseEvent[] = [
      toolStart("cmd-1"),
      toolResult("cmd-1", "Running"),
      toolResult("cmd-1", "Running test suite"),
      toolResult("cmd-1", "Running test suite\nPASS", "tool"),
    ];

    const rows = toolHistoryRows(
      getDurableAgUiHistoryItemsFromEvents(events).items,
      "cmd-1",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("Running test suite\nPASS");
  });

  it("keeps distinct tool calls in separate history rows", () => {
    const events: BaseEvent[] = [
      toolStart("cmd-1"),
      toolResult("cmd-1", "first", "tool"),
      toolStart("cmd-2"),
      toolResult("cmd-2", "second", "tool"),
    ];

    const items = getDurableAgUiHistoryItemsFromEvents(events).items;

    expect(toolHistoryRows(items, "cmd-1")).toHaveLength(1);
    expect(toolHistoryRows(items, "cmd-2")).toHaveLength(1);
    expect(toolHistoryRows(items, "cmd-1")[0]?.content).toBe("first");
    expect(toolHistoryRows(items, "cmd-2")[0]?.content).toBe("second");
  });

  it("rebuilds one ACP assistant message from streaming text deltas plus tool output", () => {
    const events: BaseEvent[] = [
      runStarted(),
      textStart("msg-acp-stream-1"),
      textContent("msg-acp-stream-1", "I'll inspect "),
      textContent("msg-acp-stream-1", "the auth middleware."),
      toolResult("tool-acp-stream-1", "npm test\nPASS\n", "tool"),
      textEnd("msg-acp-stream-1"),
      runFinished(),
    ];

    const history = getDurableAgUiHistoryItemsFromEvents(events);
    const assistantRows = assistantHistoryRows(history.items);
    const toolRows = toolHistoryRows(history.items, "tool-acp-stream-1");

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TOOL_CALL_RESULT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]?.id).toBe("msg-acp-stream-1");
    expect(assistantRows[0]?.content).toBe("I'll inspect the auth middleware.");
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0]?.content).toBe("npm test\nPASS\n");
    expect(history.lastSeqOffset).toBe(6);
  });
});
