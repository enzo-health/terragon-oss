/**
 * E2E integration test — Codex collab-agent turn.
 *
 * Two-layer assertion strategy:
 *
 * Layer 1 — Route contract: Replays codex-collab-agent-turn.jsonl through
 * the real daemon-event POST handler (in-process). Asserts every event
 * returns HTTP 200, verifying the route accepts codex-app-server payloads
 * with v2 envelopes and test-auth bypass.
 *
 * Layer 2 — UI rendering: Synthesizes the DB message parts that would result
 * from processing the Codex recording (delegation item, terminal output) and
 * asserts they render correctly via the chat-page harness. handleDaemonEvent
 * is mocked at the route level, so the DB write path is not live in tests —
 * the UI assertion operates on pre-synthesized parts that match the fixture
 * data shapes.
 */
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replay } from "./replayer";
import {
  renderDelegationItem,
  renderTerminalPart,
  queryDelegationCard,
  queryTerminalOutput,
} from "./chat-page";
import type { DBDelegationMessage } from "@terragon/shared";
import type { DBTerminalPart } from "@terragon/shared";

// ---------------------------------------------------------------------------
// Route-level mocks (same pattern as replayer.test.ts)
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
    runId: "run-codex-canonical-001",
    userId: "test-user-replay",
    threadId: "019cb55a-6ab5-7ad2-876b-dd1d3dedcf52",
    threadChatId: "chat-codex-canonical-001",
    sandboxId: "sandbox-codex-001",
    transportMode: "codex-app-server",
    protocolVersion: 1,
    agent: "codex",
    permissionMode: "allowAll",
    requestedSessionId: null,
    resolvedSessionId: null,
    status: "dispatched",
    tokenNonce: "nonce-codex",
    daemonTokenKeyId: "key-codex",
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  updateAgentRunContext: vi.fn().mockResolvedValue(null),
}));

vi.mock("@terragon/shared/model/threads", () => ({
  getThreadChat: vi.fn().mockResolvedValue(null),
  getThreadMinimal: vi.fn().mockResolvedValue(null),
  updateThreadChat: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/agent/update-status", () => ({
  updateThreadChatWithTransition: vi.fn().mockResolvedValue(undefined),
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

const CODEX_RECORDING = path.resolve(
  import.meta.dirname,
  "recordings/codex-collab-agent-turn.jsonl",
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Codex collab-agent turn — route contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replays all 5 events and gets HTTP 200 for each", async () => {
    const results = await replay(CODEX_RECORDING, { mode: "fast-forward" });
    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result.status).toBe(200);
    }
  });

  it("events are processed in wallClockMs order (0 → 600)", async () => {
    const results = await replay(CODEX_RECORDING);
    const timestamps = results.map((r) => r.wallClockMs);
    expect(timestamps).toEqual([0, 80, 200, 500, 600]);
  });

  it("all events share the codex-app-server threadId", async () => {
    const results = await replay(CODEX_RECORDING);
    for (const result of results) {
      expect(result.body.threadId).toBe("019cb55a-6ab5-7ad2-876b-dd1d3dedcf52");
      expect(result.body.transportMode).toBe("codex-app-server");
    }
  });
});

describe("Codex collab-agent turn — UI rendering (Layer 2)", () => {
  // Synthesize the delegation item and terminal output parts that
  // handleDaemonEvent would produce from the Codex recording.

  function makeDelegation(
    overrides: Partial<DBDelegationMessage> = {},
  ): DBDelegationMessage {
    return {
      type: "delegation",
      model: null,
      delegationId: "item_collab_001",
      tool: "spawn",
      status: "initiated",
      senderThreadId: "019cb55a-6ab5-7ad2-876b-dd1d3dedcf52",
      receiverThreadIds: [
        "019cb55b-7bc6-8be3-987c-ee2e4eefdg63",
        "019cb55c-8cd7-9cf4-a98d-ff3f5ffgeh74",
      ],
      prompt:
        "Please help me refactor the authentication module with improved type safety and error handling",
      delegatedModel: "claude-3-5-sonnet-20241022",
      reasoningEffort: "medium",
      agentsStates: {
        "019cb55b-7bc6-8be3-987c-ee2e4eefdg63": "initiated",
        "019cb55c-8cd7-9cf4-a98d-ff3f5ffgeh74": "initiated",
      },
      ...overrides,
    };
  }

  function makeTerminalPart(
    overrides: Partial<DBTerminalPart> = {},
  ): DBTerminalPart {
    return {
      type: "terminal",
      sandboxId: "sandbox-codex-001",
      terminalId: "term-codex-001",
      chunks: [
        {
          streamSeq: 0,
          kind: "stdout",
          text: "$ npm test\n> Running test suite...\n",
        },
        {
          streamSeq: 1,
          kind: "stdout",
          text: "PASS  src/auth/__tests__/middleware.test.ts\n",
        },
        { streamSeq: 2, kind: "stdout", text: "✓ validates token correctly" },
      ],
      ...overrides,
    };
  }

  it("renders a DelegationItemCard with initiated status", () => {
    const html = renderDelegationItem(makeDelegation({ status: "initiated" }));
    const query = queryDelegationCard(html);
    expect(query.found).toBe(true);
    expect(query.statusText).toBe("initiated");
  });

  it("renders DelegationItemCard with correct agent count (2)", () => {
    const html = renderDelegationItem(makeDelegation());
    expect(queryDelegationCard(html).agentCount).toBe(2);
  });

  it("renders DelegationItemCard with completed status after delegation done", () => {
    const html = renderDelegationItem(
      makeDelegation({
        status: "completed",
        agentsStates: {
          "019cb55b-7bc6-8be3-987c-ee2e4eefdg63": "completed",
          "019cb55c-8cd7-9cf4-a98d-ff3f5ffgeh74": "completed",
        },
      }),
    );
    expect(queryDelegationCard(html).statusText).toBe("completed");
  });

  it("renders command output from item/commandExecution/outputDelta via TerminalPartView", () => {
    const html = renderTerminalPart(makeTerminalPart());
    const query = queryTerminalOutput(html);
    expect(query.found).toBe(true);
    expect(query.kinds.has("stdout")).toBe(true);
    expect(query.text).toContain("npm test");
    expect(query.text).toContain("Running test suite");
  });

  it("accumulates 3 output delta chunks in the terminal part", () => {
    const html = renderTerminalPart(makeTerminalPart());
    const stdoutMatches = [...html.matchAll(/data-kind="stdout"/g)];
    expect(stdoutMatches.length).toBe(3);
  });

  it("does not render unknown delegation status badges", () => {
    // Ensure no console.warn emitted for unknown items — delegation card
    // handles only its known status values via AgentStatusBadge.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderDelegationItem(makeDelegation({ status: "running" }));
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
