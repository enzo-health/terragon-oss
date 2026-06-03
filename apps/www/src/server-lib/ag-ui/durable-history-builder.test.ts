import {
  type BaseEvent,
  EventType,
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
});
