/* @vitest-environment jsdom */

/**
 * AG-UI replayer integration test — Phase 7.
 *
 * Feeds a representative AG-UI BaseEvent sequence through
 * `useAgUiMessages` (via a fake HttpAgent) and asserts that the
 * resulting `UIMessage[]` has the expected shape. This is the
 * end-to-end event→UIMessage verification at the integration layer,
 * complementing the pure-reducer unit tests in
 * `apps/www/src/components/chat/ag-ui-messages-reducer.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  customRichPart,
  replayAgUi,
  textContent,
  textEnd,
  textStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  toolCallStart,
} from "./ag-ui-replayer";

describe("AG-UI replayer integration", () => {
  it("projects a streamed text message into a single UIAgentMessage with a text part", async () => {
    const events = [
      textStart("msg-1"),
      textContent("msg-1", "Hello"),
      textContent("msg-1", ", "),
      textContent("msg-1", "world."),
      textEnd("msg-1"),
    ];

    const { messages } = await replayAgUi(events);

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.role).toBe("agent");
    if (m.role !== "agent") throw new Error("type narrow");
    expect(m.id).toBe("msg-1");
    expect(m.parts).toHaveLength(1);
    expect(m.parts[0]).toMatchObject({ type: "text", text: "Hello, world." });
  });

  it("projects a tool-call lifecycle into a tool UIPart on the active assistant message", async () => {
    const events = [
      textStart("msg-1"),
      textContent("msg-1", "Listing files…"),
      textEnd("msg-1"),
      toolCallStart("tool-1", "bash"),
      toolCallArgs("tool-1", JSON.stringify({ command: "ls -la" })),
      toolCallEnd("tool-1"),
      toolCallResult("tool-1", "total 0\n"),
    ];

    const { messages } = await replayAgUi(events);

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    if (m.role !== "agent") throw new Error("type narrow");
    expect(m.parts).toHaveLength(2);
    expect(m.parts[0]).toMatchObject({ type: "text", text: "Listing files…" });
    expect(m.parts[1]).toMatchObject({
      type: "tool",
      id: "tool-1",
      name: "bash",
      status: "completed",
      result: "total 0\n",
      parameters: { command: "ls -la" },
    });
  });

  it("marks tool-call as error when TOOL_CALL_RESULT signals failure", async () => {
    const events = [
      textStart("msg-1"),
      toolCallStart("tool-fail", "bash"),
      toolCallArgs("tool-fail", JSON.stringify({ command: "false" })),
      toolCallEnd("tool-fail"),
      toolCallResult("tool-fail", "exit 1", /* isError */ true),
    ];

    const { messages } = await replayAgUi(events);
    const m = messages[0]!;
    if (m.role !== "agent") throw new Error("type narrow");
    const toolPart = m.parts.find((p) => p.type === "tool");
    expect(toolPart).toBeDefined();
    expect(toolPart).toMatchObject({ status: "error", result: "exit 1" });
  });

  it("inserts a CUSTOM rich-part (terminal) onto the referenced assistant message", async () => {
    const terminalPart = {
      type: "terminal",
      sandboxId: "sandbox-1",
      terminalId: "term-1",
      chunks: [
        { streamSeq: 0, kind: "stdout" as const, text: "hello\n" },
        { streamSeq: 1, kind: "stderr" as const, text: "warn\n" },
      ],
    };
    const events = [
      textStart("msg-rich"),
      textContent("msg-rich", "Running…"),
      textEnd("msg-rich"),
      customRichPart("terminal", "msg-rich", terminalPart),
    ];

    const { messages } = await replayAgUi(events);
    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    if (m.role !== "agent") throw new Error("type narrow");
    expect(m.parts).toHaveLength(2);
    expect(m.parts[1]).toMatchObject({
      type: "terminal",
      terminalId: "term-1",
    });
  });

  it("creates a placeholder assistant message for an orphan CUSTOM event (post-reconnect replay)", async () => {
    // Simulates SSE replay after reconnect: a CUSTOM rich-part arrives
    // for a messageId we've never seen a TEXT_MESSAGE_START for.
    const events = [
      customRichPart(
        "terminal",
        "msg-orphan",
        {
          type: "terminal",
          sandboxId: "sandbox-1",
          terminalId: "term-2",
          chunks: [],
        },
        0,
      ),
    ];

    const { messages } = await replayAgUi(events);
    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    if (m.role !== "agent") throw new Error("type narrow");
    expect(m.id).toBe("msg-orphan");
    expect(m.parts[0]).toMatchObject({ type: "terminal" });
  });

  it("folds a full mixed event stream into the expected message shape", async () => {
    // One assistant turn: text → tool call → tool result → more text →
    // rich CUSTOM diff part. Mirrors the shape of a typical
    // claude-code-standard-turn JSONL recording after mapper expansion.
    const events = [
      textStart("m1"),
      textContent("m1", "Refactoring the auth middleware."),
      textEnd("m1"),
      toolCallStart("t-ls", "bash"),
      toolCallArgs("t-ls", JSON.stringify({ command: "ls src/middleware" })),
      toolCallEnd("t-ls"),
      toolCallResult("t-ls", "auth.ts\nlogger.ts\n"),
      textStart("m2"),
      textContent("m2", "Done."),
      textEnd("m2"),
      customRichPart("diff", "m2", {
        type: "diff",
        filePath: "src/middleware/auth.ts",
        oldContent: "old",
        newContent: "new",
      }),
    ];

    const { messages, snapshots } = await replayAgUi(events);

    // 2 assistant messages
    expect(messages).toHaveLength(2);
    const [first, second] = messages;
    if (!first || first.role !== "agent") throw new Error("type narrow");
    if (!second || second.role !== "agent") throw new Error("type narrow");

    // m1 has text + tool
    expect(first.id).toBe("m1");
    expect(first.parts.map((p) => p.type)).toEqual(["text", "tool"]);
    expect(first.parts[1]).toMatchObject({ status: "completed" });

    // m2 has text + diff rich part
    expect(second.id).toBe("m2");
    expect(second.parts.map((p) => p.type)).toEqual(["text", "diff"]);

    // Snapshots grow monotonically — after the 2nd event we already have
    // some text on m1; we should never see a shrink or lost message id.
    const idSets = snapshots.map(
      (s) => new Set(s.map((m) => (m.role === "agent" ? m.id : null))),
    );
    for (let i = 1; i < idSets.length; i++) {
      const prev = idSets[i - 1]!;
      const cur = idSets[i]!;
      for (const id of prev) {
        if (id) expect(cur.has(id)).toBe(true);
      }
    }
  });
});
