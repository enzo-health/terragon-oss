/**
 * E2E integration test — Claude Code standard turn.
 *
 * Two-layer assertion strategy:
 *
 * Layer 1 — Route contract: Replays claude-code-standard-turn.jsonl through
 * the real daemon-event POST handler (in-process). Asserts every event
 * returns HTTP 200, verifying the route accepts legacy-transport payloads
 * with v2 envelopes and test-auth bypass.
 *
 * Layer 2 — UI rendering: Synthesizes the UI parts that would result from
 * processing the Claude Code recording (tool-use card, meta chips, usage chip)
 * and asserts they render correctly via the chat-page harness and direct
 * component renders. handleDaemonEvent is mocked at the route level.
 */
import path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replay } from "./replayer";
import { renderTerminalPart, queryTerminalOutput } from "./chat-page";
import { UsageChip } from "../../src/components/chat/meta-chips/usage-chip";
import { McpServerHealthChip } from "../../src/components/chat/meta-chips/mcp-server-health-chip";
import type { DBTerminalPart } from "@terragon/shared";

// ---------------------------------------------------------------------------
// Route-level mocks (same pattern as codex-turn.test.tsx)
// ---------------------------------------------------------------------------

const dbMocks = vi.hoisted(() => {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const insertReturning = vi.fn().mockResolvedValue([{ id: "sig-1" }]);
  const insertOnConflictDoNothing = vi.fn(() => ({
    returning: insertReturning,
  }));
  const insertValues = vi.fn(() => ({
    onConflictDoNothing: insertOnConflictDoNothing,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const deleteReturning = vi.fn().mockResolvedValue([{ id: "sig-1" }]);
  const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
  const deleteFrom = vi.fn(() => ({ where: deleteWhere }));
  const updateReturning = vi.fn().mockResolvedValue([{ id: "sig-1" }]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const transaction = vi.fn(async (cb: (tx: unknown) => unknown) =>
    cb({ execute, select, insert, delete: deleteFrom, update }),
  );
  return {
    execute,
    selectWhere,
    transaction,
    db: {
      execute,
      transaction,
      select,
      delete: deleteFrom,
      update,
      insert,
      query: {
        sdlcLoopSignalInbox: { findFirst: vi.fn().mockResolvedValue(null) },
      },
    },
  };
});

vi.mock("@/lib/auth-server", () => ({
  getDaemonTokenAuthContextOrNull: vi.fn().mockResolvedValue(null),
  userOnlyAction: vi.fn((fn: unknown) => fn),
}));

vi.mock("@/server-lib/handle-daemon-event", () => ({
  handleDaemonEvent: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/db", () => ({ db: dbMocks.db }));

vi.mock("@terragon/shared/delivery-loop/store/dispatch-intent-store", () => ({
  createDispatchIntent: vi.fn().mockResolvedValue("di-1"),
  markDispatchIntentDispatched: vi.fn().mockResolvedValue(undefined),
  markDispatchIntentCompleted: vi.fn().mockResolvedValue(undefined),
  markDispatchIntentFailed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server-lib/process-follow-up-queue", () => ({
  maybeProcessFollowUpQueue: vi.fn().mockResolvedValue({
    processed: false,
    dispatchLaunched: false,
    reason: "no_queued_messages",
  }),
}));

vi.mock("@/server-lib/follow-up", () => ({
  queueFollowUpInternal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server-lib/delivery-loop/dispatch-intent", () => ({
  buildDispatchIntentId: vi.fn(
    (loopId: string, runId: string) => `di_${loopId}_${runId}`,
  ),
  createDispatchIntent: vi
    .fn()
    .mockResolvedValue({ id: "di-1", status: "prepared" }),
  storeSelfDispatchReplay: vi.fn().mockResolvedValue(undefined),
  getReplayableSelfDispatch: vi.fn().mockResolvedValue(null),
  updateDispatchIntent: vi.fn().mockResolvedValue(undefined),
  getActiveDispatchIntent: vi.fn().mockResolvedValue(null),
}));

vi.mock("@terragon/shared/model/agent-run-context", () => ({
  getAgentRunContextByRunId: vi.fn().mockResolvedValue({
    runId: "run-cc-canonical-001",
    userId: "test-user-replay",
    threadId: "019cb55a-6ab5-7ad2-876b-dd1d3dedcf52",
    threadChatId: "chat-cc-canonical-001",
    sandboxId: "sandbox-cc-001",
    transportMode: "legacy",
    protocolVersion: 1,
    agent: "claude-code",
    permissionMode: "allowAll",
    requestedSessionId: null,
    resolvedSessionId: null,
    status: "dispatched",
    tokenNonce: "nonce-cc",
    daemonTokenKeyId: "key-cc",
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  updateAgentRunContext: vi.fn().mockResolvedValue(null),
}));

vi.mock("@terragon/shared/model/threads", () => ({
  getThreadChat: vi.fn().mockResolvedValue(null),
  getThreadMinimal: vi.fn().mockResolvedValue(null),
  updateThreadChat: vi.fn().mockResolvedValue(null),
  updateThreadChatTerminalMetadataIfTerminal: vi
    .fn()
    .mockResolvedValue(undefined),
}));

vi.mock("@/agent/update-status", () => ({
  updateThreadChatWithTransition: vi.fn().mockResolvedValue({
    didUpdateStatus: false,
    updatedStatus: undefined,
  }),
}));

vi.mock("@terragon/shared/delivery-loop/store/workflow-store", () => ({
  getActiveWorkflowForThread: vi.fn().mockResolvedValue(null),
}));

vi.mock("@terragon/shared/broadcast-server", () => ({
  publishBroadcastUserMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server-lib/delivery-loop/v3/kernel", () => ({
  appendEventAndAdvance: vi.fn().mockResolvedValue(undefined),
  appendEventAndAdvanceExplicit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server-lib/delivery-loop/v3/store", () => ({
  getWorkflowHead: vi.fn().mockResolvedValue(null),
  getActiveWorkflowForThread: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    pipeline: vi.fn(() => ({
      set: vi.fn(),
      del: vi.fn(),
      exec: vi.fn().mockResolvedValue([]),
    })),
  },
  isLocalRedisHttpMode: vi.fn().mockReturnValue(false),
  isRedisTransportParseError: vi.fn().mockReturnValue(false),
}));

vi.mock("@/server-lib/delivery-loop/ack-lifecycle", () => ({
  handleAckReceived: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Recording path
// ---------------------------------------------------------------------------

const CC_RECORDING = path.resolve(
  import.meta.dirname,
  "recordings/claude-code-standard-turn.jsonl",
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Claude Code standard turn — route contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replays all 5 events and gets HTTP 200 for each", async () => {
    const results = await replay(CC_RECORDING, { mode: "fast-forward" });
    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result.status).toBe(200);
    }
  });

  it("events are processed in wallClockMs order (0 → 600)", async () => {
    const results = await replay(CC_RECORDING);
    const timestamps = results.map((r) => r.wallClockMs);
    expect(timestamps).toEqual([0, 120, 240, 400, 600]);
  });

  it("all events share the legacy threadId", async () => {
    const results = await replay(CC_RECORDING);
    for (const result of results) {
      expect(result.body.threadId).toBe("019cb55a-6ab5-7ad2-876b-dd1d3dedcf52");
      expect(result.body.transportMode).toBe("legacy");
    }
  });

  it("recording contains the expected event sequence", async () => {
    const results = await replay(CC_RECORDING);
    const messageTypes = results.map(
      (r) => (r.body.messages[0] as { type: string }).type,
    );
    expect(messageTypes).toEqual([
      "system",
      "assistant",
      "assistant",
      "user",
      "result",
    ]);
  });
});

describe("Claude Code standard turn — UI rendering (Layer 2)", () => {
  // Layer 2 UI assertions use synthesized parts mirroring what handleDaemonEvent
  // would produce from the Claude Code recording fixtures.

  // -------------------------------------------------------------------------
  // UsageChip — populated from the result/success event's total_cost_usd data
  // The recording's result event carries implicit token counts; we synthesize
  // a representative usage snapshot to validate the chip renders correctly.
  // -------------------------------------------------------------------------

  it("renders UsageChip in active state with synthesized token counts", () => {
    const html = renderToStaticMarkup(
      <UsageChip
        tokenUsage={{
          inputTokens: 3200,
          cachedInputTokens: 800,
          outputTokens: 420,
        }}
      />,
    );
    expect(html).toContain('data-testid="usage-chip"');
    expect(html).toContain('data-state="active"');
    // 3200 + 420 = 3620 → "3.6k"
    expect(html).toContain("3.6k");
  });

  it("renders UsageChip in warning state when output tokens exceed 80k", () => {
    const html = renderToStaticMarkup(
      <UsageChip
        tokenUsage={{
          inputTokens: 5000,
          cachedInputTokens: 0,
          outputTokens: 85000,
        }}
      />,
    );
    expect(html).toContain('data-state="warning"');
  });

  it("renders null for UsageChip when no token data", () => {
    const html = renderToStaticMarkup(<UsageChip tokenUsage={null} />);
    expect(html).toBe("");
  });

  // -------------------------------------------------------------------------
  // McpServerHealthChip — populated from system/init mcp_servers field
  // The recording's system/init event lists github and filesystem MCP servers.
  // -------------------------------------------------------------------------

  it("renders McpServerHealthChip with github and filesystem servers (ready)", () => {
    // Synthesizes what handleDaemonEvent would set after processing system/init:
    //   mcp_servers: [{ name: "github", status: "healthy" }, { name: "filesystem", status: "healthy" }]
    const html = renderToStaticMarkup(
      <McpServerHealthChip
        mcpServerStatus={{ github: "ready", filesystem: "ready" }}
      />,
    );
    expect(html).toContain("github");
    expect(html).toContain("filesystem");
    expect(html).toContain('data-state="ready"');
  });

  it("renders McpServerHealthChip in loading state for initializing servers", () => {
    const html = renderToStaticMarkup(
      <McpServerHealthChip
        mcpServerStatus={{ github: "loading", filesystem: "loading" }}
      />,
    );
    expect(html).toContain('data-state="loading"');
  });

  it("renders null for McpServerHealthChip with no servers", () => {
    const html = renderToStaticMarkup(
      <McpServerHealthChip mcpServerStatus={{}} />,
    );
    expect(html).toBe("");
  });

  // -------------------------------------------------------------------------
  // TerminalPart — the bash tool-use from the recording produces output delta
  // chunks that accumulate into a TerminalPart (same part type as Codex).
  // We synthesize the part with the command from the recording fixture.
  // -------------------------------------------------------------------------

  function makeCCTerminalPart(
    overrides: Partial<DBTerminalPart> = {},
  ): DBTerminalPart {
    return {
      type: "terminal",
      sandboxId: "sandbox-cc-001",
      terminalId: "term-cc-001",
      chunks: [
        {
          streamSeq: 0,
          kind: "stdout",
          text: "total 24\ndrwxr-xr-x  5 user  staff   160 Apr 14 10:30 .\n",
        },
        {
          streamSeq: 1,
          kind: "stdout",
          text: "drwxr-xr-x  8 user  staff   256 Apr 14 10:25 ..\n",
        },
        {
          streamSeq: 2,
          kind: "stdout",
          text: "-rw-r--r--  1 user  staff  2847 Apr 14 10:30 auth.ts\n",
        },
      ],
      ...overrides,
    };
  }

  it("renders bash tool output as terminal chunks with stdout kind", () => {
    const html = renderTerminalPart(makeCCTerminalPart());
    const query = queryTerminalOutput(html);
    expect(query.found).toBe(true);
    expect(query.kinds.has("stdout")).toBe(true);
    expect(query.text).toContain("auth.ts");
  });

  it("accumulates 3 bash output chunks matching the tool_result fixture", () => {
    const html = renderTerminalPart(makeCCTerminalPart());
    const stdoutMatches = [...html.matchAll(/data-kind="stdout"/g)];
    expect(stdoutMatches.length).toBe(3);
  });

  it("renders the ls -la output text from the tool_result fixture", () => {
    // The recording's user/tool_result event contains the ls output from
    // the bash tool — verify the key lines appear in the synthesized chunk text.
    const html = renderTerminalPart(
      makeCCTerminalPart({
        chunks: [
          {
            streamSeq: 0,
            kind: "stdout",
            text: "total 24\ndrwxr-xr-x  5 user  staff   160 Apr 14 10:30 .\ndrwxr-xr-x  8 user  staff   256 Apr 14 10:25 ..\n-rw-r--r--  1 user  staff  2847 Apr 14 10:30 auth.ts\n-rw-r--r--  1 user  staff  1456 Apr 14 10:25 logger.ts\n-rw-r--r--  1 user  staff  1923 Apr 14 10:25 cors.ts",
          },
        ],
      }),
    );
    const query = queryTerminalOutput(html);
    expect(query.text).toContain("auth.ts");
    expect(query.text).toContain("logger.ts");
    expect(query.text).toContain("cors.ts");
  });
});
