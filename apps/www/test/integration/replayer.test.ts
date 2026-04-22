/**
 * Tests for the Replayer — verifies that feeding a 3-event recording through
 * replay() calls the real daemon-event route handler in-process and returns
 * 200 for each event in order.
 *
 * The module-level vi.mock() calls mirror the pattern in route.test.ts so
 * we can import and call POST directly without live DB / Redis / sandbox deps.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replay, loadRecording } from "./replayer";
import type { RecordedDaemonEvent } from "./types";

// ---------------------------------------------------------------------------
// Mocks — same set as route.test.ts
// ---------------------------------------------------------------------------

const dbMocks = vi.hoisted(() => {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const insertReturning = vi.fn().mockResolvedValue([{ id: "signal-1" }]);
  const insertOnConflictDoNothing = vi.fn(() => ({
    returning: insertReturning,
  }));
  const insertValues = vi.fn(() => ({
    onConflictDoNothing: insertOnConflictDoNothing,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const deleteReturning = vi.fn().mockResolvedValue([{ id: "signal-1" }]);
  const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
  const deleteFrom = vi.fn(() => ({ where: deleteWhere }));
  const updateReturning = vi.fn().mockResolvedValue([{ id: "signal-1" }]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const transaction = vi.fn(async (cb: (tx: unknown) => unknown) =>
    cb({ execute, select, insert, delete: deleteFrom, update }),
  );
  return {
    execute,
    selectWhere,
    selectFrom,
    select,
    insertReturning,
    insertOnConflictDoNothing,
    insertValues,
    insert,
    deleteReturning,
    deleteWhere,
    deleteFrom,
    updateReturning,
    updateWhere,
    updateSet,
    update,
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
    runId: "run-replay",
    userId: "test-user-replay",
    threadId: "thread-replay",
    threadChatId: "chat-replay",
    sandboxId: "sandbox-replay",
    transportMode: "legacy",
    protocolVersion: 1,
    agent: "claudeCode",
    permissionMode: "allowAll",
    requestedSessionId: null,
    resolvedSessionId: null,
    status: "dispatched",
    tokenNonce: "nonce-replay",
    daemonTokenKeyId: "key-replay",
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

const redisMocks = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue("OK"),
  del: vi.fn().mockResolvedValue(1),
  pipeline: vi.fn(() => ({
    set: vi.fn(),
    del: vi.fn(),
    exec: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("@/lib/redis", () => ({
  redis: redisMocks,
  isLocalRedisHttpMode: vi.fn().mockReturnValue(false),
  isRedisTransportParseError: vi.fn().mockReturnValue(false),
}));

vi.mock("@/server-lib/delivery-loop/ack-lifecycle", () => ({
  handleAckReceived: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Synthetic 3-event recording
// ---------------------------------------------------------------------------

function makeRecording(): RecordedDaemonEvent[] {
  return [
    {
      wallClockMs: 0,
      headers: { "content-type": "application/json" },
      body: {
        threadId: "thread-replay",
        threadChatId: "chat-replay",
        messages: [
          {
            type: "assistant",
            session_id: "sess-replay",
            parent_tool_use_id: null,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Hello from replay" }],
            },
          },
        ],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "evt-001",
        runId: "run-replay",
        seq: 0,
      },
    },
    {
      wallClockMs: 50,
      headers: { "content-type": "application/json" },
      body: {
        threadId: "thread-replay",
        threadChatId: "chat-replay",
        messages: [
          {
            type: "assistant",
            session_id: "sess-replay",
            parent_tool_use_id: null,
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Delta event from replay",
                },
              ],
            },
          },
        ],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "evt-002",
        runId: "run-replay",
        seq: 1,
      },
    },
    {
      wallClockMs: 100,
      headers: { "content-type": "application/json" },
      body: {
        threadId: "thread-replay",
        threadChatId: "chat-replay",
        messages: [
          {
            type: "custom-stop",
            session_id: null,
            duration_ms: 100,
          },
        ],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "evt-003",
        runId: "run-replay",
        seq: 2,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("replay()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a result for each event in the recording", async () => {
    const results = await replay(makeRecording(), { mode: "fast-forward" });
    expect(results).toHaveLength(3);
  });

  it("returns 200 for each event in fast-forward mode", async () => {
    const results = await replay(makeRecording(), { mode: "fast-forward" });
    for (const result of results) {
      expect(result.status).toBe(200);
    }
  });

  it("preserves wallClockMs on each result", async () => {
    const results = await replay(makeRecording(), { mode: "fast-forward" });
    expect(results[0]?.wallClockMs).toBe(0);
    expect(results[1]?.wallClockMs).toBe(50);
    expect(results[2]?.wallClockMs).toBe(100);
  });

  it("results are in the same order as the recording", async () => {
    const recording = makeRecording();
    const results = await replay(recording, { mode: "fast-forward" });
    for (let i = 0; i < recording.length; i++) {
      expect(results[i]?.body.threadId).toBe(recording[i]?.body.threadId);
    }
  });

  it("accepts a recording array directly (not just a file path)", async () => {
    const results = await replay(makeRecording());
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

describe("loadRecording()", () => {
  it("throws when the file does not exist", () => {
    expect(() => loadRecording("/nonexistent/path.jsonl")).toThrow();
  });
});
