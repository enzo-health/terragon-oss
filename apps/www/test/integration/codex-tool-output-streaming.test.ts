/**
 * E2E streaming assertion — Codex command output / MCP progress stream LIVE.
 *
 * This is the WS-C regression guard: before this work, the daemon router
 * dropped `item/commandExecution/outputDelta` and `item/mcpToolCall/progress`
 * (returned `skip`), so live command output only appeared on the terminal
 * `command_execution` completion. Now the router emits a `tool-output`
 * DaemonDelta that maps (via the REAL `mapDaemonDeltaToAgui`) to a
 * TOOL_CALL_CHUNK, which the reducer appends to the owning tool part's
 * `progressChunks`.
 *
 * The test drives the FULL daemon→render chain and asserts the chunks are
 * visible in a MID-STREAM snapshot — i.e. before the tool result arrives —
 * rather than only in the final state. That mid-stream visibility is the whole
 * point of "streams, not on completion".
 */

import { EventType, type BaseEvent } from "@ag-ui/core";
import { mapDaemonDeltaToAgui } from "@terragon/agent/ag-ui-mapper";
import { describe, expect, it } from "vitest";
import {
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  toolCallStart,
} from "./ag-ui-replayer";
import { runReducerHarness } from "./streaming-harness/reducer-harness";

type ToolOutputDelta = {
  messageId: string;
  partIndex: number;
  deltaSeq: number;
  kind: "tool-output";
  text: string;
  toolCallId: string;
  stream: "stdout" | "stderr" | "progress";
};

/**
 * Map a daemon `tool-output` delta to its AG-UI event through the real mapper,
 * exactly as the server publisher does for the live stream. Keeping this in the
 * test (rather than hand-writing a TOOL_CALL_CHUNK) is deliberate: it asserts
 * the daemon delta shape and the mapper agree end-to-end.
 */
function chunkFromDelta(delta: ToolOutputDelta, timestamp = 0): BaseEvent {
  return mapDaemonDeltaToAgui(delta, timestamp);
}

function findToolPart(
  messages: import("@terragon/shared").UIMessage[],
  toolCallId: string,
): Record<string, unknown> | undefined {
  for (const message of messages) {
    if (message.role !== "agent") continue;
    for (const part of message.parts) {
      const record = part as Record<string, unknown>;
      // The reducer keys a tool part by `id` (the tool-call id), not a
      // separate `toolCallId` field.
      if (record.type === "tool" && record.id === toolCallId) {
        return record;
      }
    }
  }
  return undefined;
}

describe("Codex tool-output streams live into the owning tool card", () => {
  it("command output appears in progressChunks BEFORE the tool result (mid-stream)", () => {
    const toolCallId = "item_cmd_001";
    const events: BaseEvent[] = [
      toolCallStart(toolCallId, "Bash"),
      toolCallArgs(toolCallId, JSON.stringify({ command: "npm test" })),
      toolCallEnd(toolCallId),
      // Live command output streamed as the command runs. Each chunk is a
      // daemon `tool-output` delta routed through the real mapper.
      chunkFromDelta({
        messageId: toolCallId,
        partIndex: 0,
        deltaSeq: 0,
        kind: "tool-output",
        text: "$ npm test\n",
        toolCallId,
        stream: "stdout",
      }),
      chunkFromDelta({
        messageId: toolCallId,
        partIndex: 0,
        deltaSeq: 1,
        kind: "tool-output",
        text: "PASS src/auth.test.ts\n",
        toolCallId,
        stream: "stdout",
      }),
      // Final result arrives last.
      toolCallResult(toolCallId, "$ npm test\nPASS src/auth.test.ts\n"),
    ];

    const result = runReducerHarness(events);

    // The mapper must have produced TOOL_CALL_CHUNK events, not text content.
    const chunkEvents = events.filter(
      (event) => event.type === EventType.TOOL_CALL_CHUNK,
    );
    expect(chunkEvents).toHaveLength(2);

    // snapshots[i] is the message tree AFTER processing events[0..i-1].
    // The two chunk events are at indices 3 and 4; the result is at index 5.
    // So snapshots[5] is the state AFTER both chunks but BEFORE the result —
    // the mid-stream view that proves the output streamed live.
    const midStreamSnapshot = result.snapshots[5]!;
    const midStreamTool = findToolPart(midStreamSnapshot, toolCallId);
    expect(midStreamTool).toBeDefined();
    const midStreamChunks = (midStreamTool!.progressChunks ?? []) as Array<{
      seq: number;
      text: string;
    }>;
    expect(midStreamChunks.map((chunk) => chunk.text)).toEqual([
      "$ npm test\n",
      "PASS src/auth.test.ts\n",
    ]);
    // Tool is still in-progress mid-stream — the result has not landed yet.
    expect(midStreamTool!.toolStatus).toBe("in_progress");

    // Final state: the tool resolved, and the streamed chunks are retained.
    const finalTool = findToolPart(result.finalMessages, toolCallId);
    expect(finalTool).toBeDefined();
    const finalChunks = (finalTool!.progressChunks ?? []) as Array<{
      seq: number;
      text: string;
    }>;
    expect(finalChunks).toHaveLength(2);
  });

  it("MCP progress messages stream as progress chunks under the MCP tool card", () => {
    const toolCallId = "item_mcp_001";
    const events: BaseEvent[] = [
      toolCallStart(toolCallId, "mcp__ide__getDiagnostics"),
      toolCallEnd(toolCallId),
      chunkFromDelta({
        messageId: toolCallId,
        partIndex: 0,
        deltaSeq: 0,
        kind: "tool-output",
        text: "Analyzing file structure... (step 2/5)",
        toolCallId,
        stream: "progress",
      }),
      chunkFromDelta({
        messageId: toolCallId,
        partIndex: 0,
        deltaSeq: 1,
        kind: "tool-output",
        text: "Resolving symbols... (step 4/5)",
        toolCallId,
        stream: "progress",
      }),
    ];

    const result = runReducerHarness(events);

    const tool = findToolPart(result.finalMessages, toolCallId);
    expect(tool).toBeDefined();
    const chunks = (tool!.progressChunks ?? []) as Array<{
      seq: number;
      text: string;
    }>;
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "Analyzing file structure... (step 2/5)",
      "Resolving symbols... (step 4/5)",
    ]);
  });
});
