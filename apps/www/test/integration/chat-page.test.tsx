/**
 * UI assertion harness tests.
 *
 * Verifies the chat-page harness helpers used by the turn tests. The live
 * transcript renders text through the production `TextPart` (the text leaf's
 * markdown slot); terminal and delegation parts surface in production as the
 * persisted DB part shape that the live AG-UI mapper consumes, so the harness
 * exposes data-shape query helpers over those parts rather than rendering the
 * removed bespoke views.
 */
import { describe, expect, it } from "vitest";
import {
  queryDelegation,
  queryTerminalChunks,
  renderMessagePart,
} from "./chat-page";
import type { DBDelegationMessage } from "@terragon/shared";
import type { DBTerminalPart } from "@terragon/shared";

// ---------------------------------------------------------------------------
// Delegation projection
// ---------------------------------------------------------------------------

describe("queryDelegation", () => {
  function makeDelegation(
    overrides: Partial<DBDelegationMessage> = {},
  ): DBDelegationMessage {
    return {
      type: "delegation",
      model: null,
      delegationId: "del-integration-001",
      tool: "spawn",
      status: "initiated",
      senderThreadId: "thread-sender",
      receiverThreadIds: ["thread-a", "thread-b"],
      prompt: "Refactor authentication module",
      delegatedModel: "claude-3-5-sonnet-20241022",
      reasoningEffort: "medium",
      agentsStates: {},
      ...overrides,
    };
  }

  it("projects an initiated delegation status", () => {
    const query = queryDelegation(makeDelegation({ status: "initiated" }));
    expect(query.found).toBe(true);
    expect(query.statusText).toBe("initiated");
  });

  it("projects a running delegation status", () => {
    expect(
      queryDelegation(makeDelegation({ status: "running" })).statusText,
    ).toBe("running");
  });

  it("projects a completed delegation status", () => {
    expect(
      queryDelegation(makeDelegation({ status: "completed" })).statusText,
    ).toBe("completed");
  });

  it("counts agents from receiverThreadIds", () => {
    const query = queryDelegation(
      makeDelegation({ receiverThreadIds: ["a", "b", "c"] }),
    );
    expect(query.agentCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Terminal chunk projection
// ---------------------------------------------------------------------------

describe("queryTerminalChunks", () => {
  function makePart(overrides: Partial<DBTerminalPart> = {}): DBTerminalPart {
    return {
      type: "terminal",
      sandboxId: "sandbox-integration-001",
      terminalId: "term-int-1",
      chunks: [],
      ...overrides,
    };
  }

  it("projects stdout chunks with the stdout kind", () => {
    const query = queryTerminalChunks(
      makePart({
        chunks: [{ streamSeq: 0, kind: "stdout", text: "npm test passed" }],
      }),
    );
    expect(query.found).toBe(true);
    expect(query.kinds.has("stdout")).toBe(true);
    expect(query.text).toContain("npm test passed");
  });

  it("projects stderr chunks", () => {
    const query = queryTerminalChunks(
      makePart({
        chunks: [
          { streamSeq: 0, kind: "stderr", text: "Error: file not found" },
        ],
      }),
    );
    expect(query.kinds.has("stderr")).toBe(true);
  });

  it("accumulates 2 delta chunks in stream order", () => {
    // Simulate what happens after 2 item/commandExecution/outputDelta events:
    // each event appends a chunk to the terminal part.
    const query = queryTerminalChunks(
      makePart({
        chunks: [
          { streamSeq: 0, kind: "stdout", text: "Running tests...\n" },
          { streamSeq: 1, kind: "stdout", text: "All tests passed!\n" },
        ],
      }),
    );
    expect(query.text).toContain("Running tests...");
    expect(query.text).toContain("All tests passed!");
    expect(query.kindCounts.stdout).toBe(2);
  });

  it("projects empty text for a part with no chunks", () => {
    const query = queryTerminalChunks(makePart());
    expect(query.found).toBe(true);
    expect(query.text).toBe("");
    expect(query.kinds.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// renderMessagePart — text rendering via production TextPart
// ---------------------------------------------------------------------------

describe("renderMessagePart", () => {
  it("renders a text part through the production TextPart", () => {
    const html = renderMessagePart({ type: "text", text: "hello world" });
    expect(html).toContain("hello world");
  });

  it("returns empty string for parts with no production text renderer", () => {
    const html = renderMessagePart({ type: "thinking", thinking: "internal" });
    expect(html).toBe("");
  });
});
