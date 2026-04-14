/**
 * UI assertion harness tests.
 *
 * Verifies that the chat-page helpers render delegation, terminal, and
 * message-part content correctly from synthesized UI parts — without needing
 * a live DB or full ChatUI mount.
 *
 * The "delta events → rendered DOM" assertion is achieved by synthesizing
 * the accumulated message state (as toUIMessages.ts would produce after
 * processing the events) and passing it directly to the renderers.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import {
  renderDelegationItem,
  renderTerminalPart,
  renderMessagePart,
  queryDelegationCard,
  queryTerminalOutput,
} from "./chat-page";
import type { DBDelegationMessage } from "@terragon/shared";
import type { DBTerminalPart } from "@terragon/shared";

// ---------------------------------------------------------------------------
// Delegation item rendering
// ---------------------------------------------------------------------------

describe("renderDelegationItem", () => {
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

  it("renders an initiated DelegationItemCard with status badge", () => {
    const html = renderDelegationItem(makeDelegation({ status: "initiated" }));
    const query = queryDelegationCard(html);
    expect(query.found).toBe(true);
    expect(query.statusText).toBe("initiated");
  });

  it("renders a running DelegationItemCard", () => {
    const html = renderDelegationItem(makeDelegation({ status: "running" }));
    expect(queryDelegationCard(html).statusText).toBe("running");
  });

  it("renders a completed DelegationItemCard", () => {
    const html = renderDelegationItem(makeDelegation({ status: "completed" }));
    expect(queryDelegationCard(html).statusText).toBe("completed");
  });

  it("shows agent count from receiverThreadIds", () => {
    const html = renderDelegationItem(
      makeDelegation({ receiverThreadIds: ["a", "b", "c"] }),
    );
    expect(queryDelegationCard(html).agentCount).toBe(3);
  });

  it("contains a prompt toggle button", () => {
    // The prompt itself is collapsed by default (useState starts false in SSR),
    // but the "Prompt" toggle button is always rendered.
    const html = renderDelegationItem(makeDelegation());
    expect(html).toContain("Prompt");
  });
});

// ---------------------------------------------------------------------------
// Terminal part rendering
// ---------------------------------------------------------------------------

describe("renderTerminalPart", () => {
  function makePart(overrides: Partial<DBTerminalPart> = {}): DBTerminalPart {
    return {
      type: "terminal",
      sandboxId: "sandbox-integration-001",
      terminalId: "term-int-1",
      chunks: [],
      ...overrides,
    };
  }

  it("renders stdout chunks with data-kind attribute", () => {
    const part = makePart({
      chunks: [{ streamSeq: 0, kind: "stdout", text: "npm test passed" }],
    });
    const html = renderTerminalPart(part);
    const query = queryTerminalOutput(html);
    expect(query.found).toBe(true);
    expect(query.kinds.has("stdout")).toBe(true);
    expect(query.text).toContain("npm test passed");
  });

  it("renders stderr chunks", () => {
    const part = makePart({
      chunks: [{ streamSeq: 0, kind: "stderr", text: "Error: file not found" }],
    });
    const html = renderTerminalPart(part);
    expect(queryTerminalOutput(html).kinds.has("stderr")).toBe(true);
  });

  it("simulates 2 delta events by accumulating chunks", () => {
    // Simulate what happens after 2 item/commandExecution/outputDelta events:
    // each event appends a chunk to the terminal part.
    const part = makePart({
      chunks: [
        { streamSeq: 0, kind: "stdout", text: "Running tests...\n" },
        { streamSeq: 1, kind: "stdout", text: "All tests passed!\n" },
      ],
    });
    const html = renderTerminalPart(part);
    const query = queryTerminalOutput(html);
    expect(query.text).toContain("Running tests...");
    expect(query.text).toContain("All tests passed!");
    // Both deltas map to the same kind
    const kindMatches = [...html.matchAll(/data-kind="stdout"/g)];
    expect(kindMatches.length).toBe(2);
  });

  it("shows empty state for a part with no chunks", () => {
    const html = renderTerminalPart(makePart());
    expect(html).toContain("No output");
  });
});

// ---------------------------------------------------------------------------
// renderMessagePart type coverage
// ---------------------------------------------------------------------------

describe("renderMessagePart", () => {
  // MessagePart is a memo-wrapped dispatcher that routes to leaf renderers.
  // The MessagePart test in message-part.test.tsx documents why we avoid
  // full SSR rendering of the dispatcher (React 19 + renderToStaticMarkup is
  // flaky for components with useMemo/useRef/useEffect). The harness exposes
  // renderMessagePart for test authors who need it, but the canonical approach
  // for hook-heavy part types is to render leaf components directly
  // (renderDelegationItem, renderTerminalPart) which is what 6.7 and 6.8 do.
  //
  // This test just ensures renderMessagePart is callable and exported.
  it("is exported from the harness module", () => {
    expect(typeof renderMessagePart).toBe("function");
  });
});
