import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { getDaemonTokenAuthContextOrNull } from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import {
  createDispatchIntent as createDurableDispatchIntent,
  getActiveSdlcLoopForThread,
  markDispatchIntentCompleted,
  markDispatchIntentDispatched,
  markDispatchIntentFailed,
} from "@terragon/shared/model/delivery-loop";
import {
  getAgentRunContextByRunId,
  updateAgentRunContext,
} from "@terragon/shared/model/agent-run-context";
import { maybeProcessFollowUpQueue } from "@/server-lib/process-follow-up-queue";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import {
  DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
  DAEMON_EVENT_CAPABILITIES_HEADER,
} from "@terragon/daemon/shared";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import { getThreadChat } from "@terragon/shared/model/threads";

const dbMocks = vi.hoisted(() => {
  const execute = vi.fn();
  const selectWhere = vi.fn();
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const insertReturning = vi.fn();
  const insertOnConflictDoNothing = vi.fn(() => ({
    returning: insertReturning,
  }));
  const insertValues = vi.fn(() => ({
    onConflictDoNothing: insertOnConflictDoNothing,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const deleteReturning = vi.fn();
  const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
  const deleteFrom = vi.fn(() => ({ where: deleteWhere }));
  const updateReturning = vi.fn();
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const signalInboxFindFirst = vi.fn();
  type MockTransactionClient = {
    execute: typeof execute;
    select: typeof select;
    insert: typeof insert;
    delete: typeof deleteFrom;
    update: typeof update;
  };
  const tx: MockTransactionClient = {
    execute,
    select,
    insert,
    delete: deleteFrom,
    update,
  };
  const transaction = vi.fn(
    async (callback: (client: MockTransactionClient) => unknown) =>
      callback(tx),
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
    signalInboxFindFirst,
    transaction,
    db: {
      execute,
      transaction,
      select,
      delete: deleteFrom,
      update,
      query: {
        sdlcLoopSignalInbox: {
          findFirst: signalInboxFindFirst,
        },
      },
    },
  };
});

const dispatchIntentMocks = vi.hoisted(() => ({
  buildDispatchIntentId: vi.fn(
    (loopId: string, runId: string) => `di_${loopId}_${runId}`,
  ),
  createDispatchIntent: vi.fn(),
  storeSelfDispatchReplay: vi.fn(),
  getReplayableSelfDispatch: vi.fn(),
  updateDispatchIntent: vi.fn(),
  getActiveDispatchIntent: vi.fn().mockResolvedValue(null),
}));

const deliveryLoopModelMocks = vi.hoisted(() => ({
  createDispatchIntent: vi.fn(),
  getActiveSdlcLoopForThread: vi.fn(),
  markDispatchIntentDispatched: vi.fn(),
  markDispatchIntentCompleted: vi.fn(),
  markDispatchIntentFailed: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({
  getDaemonTokenAuthContextOrNull: vi.fn(),
}));

vi.mock("@/server-lib/handle-daemon-event", () => ({
  handleDaemonEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: dbMocks.db,
}));

vi.mock("@terragon/shared/model/delivery-loop", () => ({
  createDispatchIntent: deliveryLoopModelMocks.createDispatchIntent,
  getActiveSdlcLoopForThread: deliveryLoopModelMocks.getActiveSdlcLoopForThread,
  markDispatchIntentDispatched:
    deliveryLoopModelMocks.markDispatchIntentDispatched,
  markDispatchIntentCompleted:
    deliveryLoopModelMocks.markDispatchIntentCompleted,
  markDispatchIntentFailed: deliveryLoopModelMocks.markDispatchIntentFailed,
  SDLC_CAUSE_IDENTITY_VERSION: 1,
}));

vi.mock("@/server-lib/process-follow-up-queue", () => ({
  maybeProcessFollowUpQueue: vi.fn(),
}));

vi.mock("@/server-lib/follow-up", () => ({
  queueFollowUpInternal: vi.fn(),
}));

vi.mock("@/server-lib/delivery-loop/dispatch-intent", () => ({
  buildDispatchIntentId: dispatchIntentMocks.buildDispatchIntentId,
  createDispatchIntent: dispatchIntentMocks.createDispatchIntent,
  storeSelfDispatchReplay: dispatchIntentMocks.storeSelfDispatchReplay,
  getReplayableSelfDispatch: dispatchIntentMocks.getReplayableSelfDispatch,
  updateDispatchIntent: dispatchIntentMocks.updateDispatchIntent,
  getActiveDispatchIntent: dispatchIntentMocks.getActiveDispatchIntent,
}));

vi.mock("@terragon/shared/model/agent-run-context", () => ({
  getAgentRunContextByRunId: vi.fn(),
  updateAgentRunContext: vi.fn(),
}));

// Explicit mock for threads module — only mock the functions the route directly imports.
// Using a factory (not auto-mock) prevents transitive consumers like @/agent/update-status
// from receiving mocked versions of functions they rely on internally.
vi.mock("@terragon/shared/model/threads", () => ({
  getThreadChat: vi.fn(),
  getThreadMinimal: vi.fn(),
  updateThreadChat: vi.fn(),
}));

// Mock update-status to isolate the route from the real thread state-machine logic.
vi.mock("@/agent/update-status", () => ({
  updateThreadChatWithTransition: vi.fn(),
}));

vi.mock("@terragon/shared/delivery-loop/store/workflow-store", () => ({
  getActiveWorkflowForThread: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/server-lib/delivery-loop/coordinator/enrollment-bridge", () => ({
  ensureV2WorkflowExists: vi
    .fn()
    .mockResolvedValue({ workflowId: "wf-backfilled", created: true }),
}));

vi.mock("@/server-lib/delivery-loop/coordinator/tick", () => ({
  runCoordinatorTick: vi.fn().mockResolvedValue({
    transitioned: false,
    signalsProcessed: 0,
    workItemsScheduled: 0,
  }),
}));

function createDaemonRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  options: { autoCapabilities?: boolean } = {},
) {
  // Default to ACP transport to match the default beforeEach mock.
  // Tests that need different transport (e.g. legacy, codex-app-server)
  // should explicitly specify transportMode/protocolVersion.
  const bodyWithDefaults: Record<string, unknown> = {
    transportMode: "acp",
    protocolVersion: 2,
    ...body,
  };
  const requestHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...headers,
  };

  const hasEnvelopeV2 =
    bodyWithDefaults.payloadVersion === 2 &&
    typeof bodyWithDefaults.eventId === "string" &&
    bodyWithDefaults.eventId.length > 0 &&
    typeof bodyWithDefaults.runId === "string" &&
    bodyWithDefaults.runId.length > 0 &&
    typeof bodyWithDefaults.seq === "number" &&
    Number.isInteger(bodyWithDefaults.seq) &&
    bodyWithDefaults.seq >= 0;
  if (
    (options.autoCapabilities ?? true) &&
    hasEnvelopeV2 &&
    !requestHeaders[DAEMON_EVENT_CAPABILITIES_HEADER]
  ) {
    requestHeaders[DAEMON_EVENT_CAPABILITIES_HEADER] =
      DAEMON_CAPABILITY_EVENT_ENVELOPE_V2;
  }

  return new Request("http://localhost/api/daemon-event", {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(bodyWithDefaults),
  });
}

function createSuccessResultMessage(sessionId = "session-1") {
  return {
    type: "result",
    subtype: "success",
    total_cost_usd: 0,
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: false,
    num_turns: 1,
    result: "ok",
    session_id: sessionId,
  };
}

const MOCK_SELF_DISPATCH_REPLAY_PAYLOAD = {
  token: "token-1",
  prompt: "Please address this feedback.",
  runId: "run-next",
  tokenNonce: "nonce-next",
  model: "gpt-5.3-codex",
  agent: "codex",
  agentVersion: 2,
  sessionId: null,
  featureFlags: {},
  permissionMode: "allowAll",
  transportMode: "codex-app-server",
  protocolVersion: 1,
  threadId: "thread-1",
  threadChatId: "chat-1",
};

describe("daemon-event route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue({
      userId: "user-1",
      keyId: "api-key-1",
      claims: {
        kind: "daemon-run",
        runId: "run-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
        sandboxId: "sandbox-1",
        agent: "claudeCode",
        transportMode: "acp",
        protocolVersion: 2,
        providers: ["anthropic"],
        nonce: "nonce-1",
        issuedAt: Date.now(),
        exp: Date.now() + 60_000,
      },
    });
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
      runId: "run-1",
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      sandboxId: "sandbox-1",
      transportMode: "acp",
      protocolVersion: 2,
      agent: "claudeCode",
      permissionMode: "allowAll",
      requestedSessionId: null,
      resolvedSessionId: null,
      status: "dispatched",
      tokenNonce: "nonce-1",
      daemonTokenKeyId: "api-key-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);
    vi.mocked(updateAgentRunContext).mockResolvedValue(null);
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue(undefined);
    vi.mocked(createDurableDispatchIntent).mockResolvedValue(
      "durable-dispatch-intent-1",
    );
    vi.mocked(markDispatchIntentDispatched).mockResolvedValue(undefined);
    vi.mocked(markDispatchIntentCompleted).mockResolvedValue(undefined);
    vi.mocked(markDispatchIntentFailed).mockResolvedValue(undefined);
    vi.mocked(handleDaemonEvent).mockResolvedValue({ success: true });
    vi.mocked(maybeProcessFollowUpQueue).mockResolvedValue({
      processed: false,
      reason: "no_queued_messages",
    });
    vi.mocked(queueFollowUpInternal).mockResolvedValue(undefined);
    dispatchIntentMocks.createDispatchIntent.mockResolvedValue({
      id: "di_loop-1_run-next",
      status: "prepared",
    });
    dispatchIntentMocks.storeSelfDispatchReplay.mockResolvedValue(undefined);
    dispatchIntentMocks.getReplayableSelfDispatch.mockResolvedValue(null);
    dispatchIntentMocks.updateDispatchIntent.mockResolvedValue(undefined);
    dbMocks.execute.mockResolvedValue({ rows: [] });
    dbMocks.selectWhere.mockResolvedValue([]);
    dbMocks.insertReturning.mockResolvedValue([{ id: "signal-1" }]);
    dbMocks.deleteReturning.mockResolvedValue([{ id: "signal-1" }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: "signal-1" }]);
    dbMocks.signalInboxFindFirst.mockResolvedValue(null);
  });

  it("returns 401 when daemon token auth fails", async () => {
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue(null);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
      }),
    );

    expect(response.status).toBe(401);
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("rejects enrolled-loop daemon events without v2 envelope when daemon advertises v2 capability", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);

    const response = await POST(
      createDaemonRequest(
        {
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [],
          timezone: "UTC",
        },
        {
          [DAEMON_EVENT_CAPABILITIES_HEADER]:
            DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
        },
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("daemon_event_capability_v2_requires_v2_envelope");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("rejects enrolled-loop daemon events with malformed v2 envelope when daemon advertises v2 capability", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);

    const response = await POST(
      createDaemonRequest(
        {
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [],
          timezone: "UTC",
          payloadVersion: 2,
          runId: "run-1",
          seq: 0,
        },
        {
          [DAEMON_EVENT_CAPABILITIES_HEADER]:
            DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
        },
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("daemon_event_capability_v2_requires_v2_envelope");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("rejects v2 envelope payloads when the daemon does not advertise v2 envelope capability", async () => {
    const response = await POST(
      createDaemonRequest(
        {
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-1",
          runId: "run-1",
          seq: 0,
        },
        {},
        { autoCapabilities: false },
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("daemon_event_v2_envelope_requires_capability_v2");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("accepts legacy daemon payloads with the legacy threadChat sentinel", async () => {
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue({
      userId: "user-1",
      keyId: "api-key-1",
      claims: {
        kind: "daemon-run",
        runId: "run-1",
        threadId: "thread-1",
        threadChatId: LEGACY_THREAD_CHAT_ID,
        sandboxId: "sandbox-1",
        agent: "claudeCode",
        transportMode: "legacy",
        protocolVersion: 1,
        providers: ["anthropic"],
        nonce: "nonce-1",
        issuedAt: Date.now(),
        exp: Date.now() + 60_000,
      },
    } as any);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
      runId: "run-1",
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: LEGACY_THREAD_CHAT_ID,
      sandboxId: "sandbox-1",
      transportMode: "legacy",
      protocolVersion: 1,
      agent: "claudeCode",
      permissionMode: "allowAll",
      requestedSessionId: null,
      resolvedSessionId: null,
      status: "dispatched",
      tokenNonce: "nonce-1",
      daemonTokenKeyId: "api-key-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: LEGACY_THREAD_CHAT_ID,
        messages: [
          {
            type: "system",
            subtype: "init",
            session_id: "session-1",
            tools: [],
            mcp_servers: [],
          },
        ],
        timezone: "UTC",
        transportMode: "legacy",
        protocolVersion: 1,
        payloadVersion: 2,
        eventId: "event-legacy",
        runId: "run-1",
        seq: 0,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
    expect(data.acknowledgedEventId).toBe("event-legacy");
    expect(data.acknowledgedSeq).toBe(0);
  });

  it("requires threadChatId for ACP daemon payloads", async () => {
    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        messages: [],
        timezone: "UTC",
        transportMode: "acp",
        protocolVersion: 2,
        payloadVersion: 2,
        eventId: "event-1",
        runId: "run-1",
        seq: 0,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("daemon_event_non_legacy_requires_thread_chat_id");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("requires a real threadChatId for codex app-server payloads", async () => {
    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: LEGACY_THREAD_CHAT_ID,
        messages: [],
        timezone: "UTC",
        transportMode: "codex-app-server",
        protocolVersion: 1,
        payloadVersion: 2,
        eventId: "event-1",
        runId: "run-1",
        seq: 0,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("daemon_event_non_legacy_requires_thread_chat_id");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("returns v2 acknowledgements when a run is already terminal", async () => {
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
      runId: "run-1",
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      sandboxId: "sandbox-1",
      transportMode: "acp",
      protocolVersion: 2,
      agent: "claudeCode",
      permissionMode: "allowAll",
      requestedSessionId: null,
      resolvedSessionId: null,
      status: "completed",
      tokenNonce: "nonce-1",
      daemonTokenKeyId: "api-key-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [
          {
            type: "system",
            subtype: "init",
            session_id: "session-1",
            tools: [],
            mcp_servers: [],
          },
        ],
        timezone: "UTC",
        transportMode: "acp",
        payloadVersion: 2,
        eventId: "event-terminal",
        runId: "run-1",
        seq: 0,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.reason).toBe("run_terminal_ignored");
    expect(data.acknowledgedEventId).toBe("event-terminal");
    expect(data.acknowledgedSeq).toBe(0);
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("replays self-dispatch on run_terminal_ignored responses", async () => {
    dispatchIntentMocks.getReplayableSelfDispatch.mockResolvedValue(
      MOCK_SELF_DISPATCH_REPLAY_PAYLOAD,
    );
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
      runId: "run-1",
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      sandboxId: "sandbox-1",
      transportMode: "acp",
      protocolVersion: 2,
      agent: "claudeCode",
      permissionMode: "allowAll",
      requestedSessionId: null,
      resolvedSessionId: null,
      status: "completed",
      tokenNonce: "nonce-1",
      daemonTokenKeyId: "api-key-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-terminal",
        runId: "run-1",
        seq: 0,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.reason).toBe("run_terminal_ignored");
    expect(data.selfDispatch).toEqual(
      expect.objectContaining({
        runId: "run-next",
        prompt: "Please address this feedback.",
      }),
    );
  });

  // Removed: "re-enqueues daemon-terminal feedback" — v1 follow-up re-enqueue
  // logic was removed; v2 handles dispatch via work items.

  it("replays self-dispatch on duplicate terminal acknowledgements", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      loopVersion: 7,
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);
    dbMocks.insertReturning.mockResolvedValue([]);
    dispatchIntentMocks.getReplayableSelfDispatch.mockResolvedValue(
      MOCK_SELF_DISPATCH_REPLAY_PAYLOAD,
    );
    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-dup-terminal",
        runId: "run-1",
        seq: 3,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.deduplicated).toBe(true);
    expect(data.reason).toBe("duplicate_event");
    expect(data.selfDispatch).toEqual(
      expect.objectContaining({
        runId: "run-next",
      }),
    );
  });

  it("replays self-dispatch on out-of-order terminal acknowledgements", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      loopVersion: 7,
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);
    dbMocks.selectWhere
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ maxSeq: 3 }]);
    dispatchIntentMocks.getReplayableSelfDispatch.mockResolvedValue(
      MOCK_SELF_DISPATCH_REPLAY_PAYLOAD,
    );

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-out-of-order",
        runId: "run-1",
        seq: 2,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.deduplicated).toBe(true);
    expect(data.reason).toBe("out_of_order_or_duplicate_seq");
    expect(data.selfDispatch).toEqual(
      expect.objectContaining({
        runId: "run-next",
      }),
    );
  });

  it("blocks auto-dispatch when consecutive completed runs exceed threshold", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      loopVersion: 7,
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);
    // First execute call is advisory lock for claim; second call is the breaker query.
    dbMocks.execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: Array.from({ length: 10 }, () => ({
        daemonRunStatus: "completed",
        autoDispatchProvenance: true,
      })),
    });

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-circuit-breaker",
        runId: "run-1",
        seq: 0,
      }),
    );

    expect(response.status).toBe(200);
    // Circuit breaker should prevent follow-up processing
    expect(queueFollowUpInternal).not.toHaveBeenCalled();
    expect(maybeProcessFollowUpQueue).not.toHaveBeenCalled();
  });

  // Removed: "does not trip circuit breaker" — v1 auto-dispatch circuit breaker
  // was removed; v2 uses self-dispatch with its own circuit breaker in daemon-ingress.

  it("persists codexPreviousResponseId for successful codex app-server completions", async () => {
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue({
      userId: "user-1",
      keyId: "api-key-1",
      claims: {
        kind: "daemon-run",
        runId: "run-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
        sandboxId: "sandbox-1",
        agent: "codex",
        transportMode: "codex-app-server",
        protocolVersion: 1,
        providers: ["openai"],
        nonce: "nonce-1",
        issuedAt: Date.now(),
        exp: Date.now() + 60_000,
      },
    } as any);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
      runId: "run-1",
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      sandboxId: "sandbox-1",
      transportMode: "codex-app-server",
      protocolVersion: 1,
      agent: "codex",
      permissionMode: "allowAll",
      requestedSessionId: null,
      resolvedSessionId: null,
      status: "dispatched",
      tokenNonce: "nonce-1",
      daemonTokenKeyId: "api-key-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [
          {
            type: "result",
            subtype: "success",
            total_cost_usd: 0,
            duration_ms: 10,
            duration_api_ms: 10,
            is_error: false,
            num_turns: 1,
            result: "ok",
            session_id: "codex-thread-1",
          },
        ],
        timezone: "UTC",
        transportMode: "codex-app-server",
        protocolVersion: 1,
        codexPreviousResponseId: "resp-next-999",
      }),
    );

    expect(response.status).toBe(200);
    expect(dbMocks.update).toHaveBeenCalledTimes(1);
    expect(dbMocks.updateSet).toHaveBeenCalledWith({
      codexPreviousResponseId: "resp-next-999",
    });
  });

  it("rejects invalid codexPreviousResponseId payload types", async () => {
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue({
      userId: "user-1",
      keyId: "api-key-1",
      claims: {
        kind: "daemon-run",
        runId: "run-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
        sandboxId: "sandbox-1",
        agent: "codex",
        transportMode: "codex-app-server",
        protocolVersion: 1,
        providers: ["openai"],
        nonce: "nonce-1",
        issuedAt: Date.now(),
        exp: Date.now() + 60_000,
      },
    } as any);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
      runId: "run-1",
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      sandboxId: "sandbox-1",
      transportMode: "codex-app-server",
      protocolVersion: 1,
      agent: "codex",
      permissionMode: "allowAll",
      requestedSessionId: null,
      resolvedSessionId: null,
      status: "dispatched",
      tokenNonce: "nonce-1",
      daemonTokenKeyId: "api-key-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage("codex-thread-1")],
        timezone: "UTC",
        transportMode: "codex-app-server",
        protocolVersion: 1,
        codexPreviousResponseId: 123,
      }),
    );
    // Invalid codexPreviousResponseId is now non-fatal to avoid rolling back
    // claimed signals after terminal side effects (which would lose the signal).
    // The handler skips codex persistence and continues to success.
    expect(response.status).toBe(200);
    expect(dbMocks.update).not.toHaveBeenCalled();
  });

  it("does not fail enrolled-loop event handling when codexPreviousResponseId persistence fails", async () => {
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue({
      userId: "user-1",
      keyId: "api-key-1",
      claims: {
        kind: "daemon-run",
        runId: "run-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
        sandboxId: "sandbox-1",
        agent: "codex",
        transportMode: "codex-app-server",
        protocolVersion: 1,
        providers: ["openai"],
        nonce: "nonce-1",
        issuedAt: Date.now(),
        exp: Date.now() + 60_000,
      },
    } as any);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
      runId: "run-1",
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      sandboxId: "sandbox-1",
      transportMode: "codex-app-server",
      protocolVersion: 1,
      agent: "codex",
      permissionMode: "allowAll",
      requestedSessionId: null,
      resolvedSessionId: null,
      status: "dispatched",
      tokenNonce: "nonce-1",
      daemonTokenKeyId: "api-key-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      state: "planning",
      loopVersion: 11,
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);
    dbMocks.updateSet.mockImplementationOnce(() => {
      throw new Error("db write failed");
    });

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage("codex-thread-1")],
        timezone: "UTC",
        transportMode: "codex-app-server",
        protocolVersion: 1,
        codexPreviousResponseId: "resp-next-999",
        payloadVersion: 2,
        eventId: "event-persist-fail",
        runId: "run-1",
        seq: 4,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      acknowledgedEventId: "event-persist-fail",
      acknowledgedSeq: 4,
    });
    expect(dbMocks.deleteFrom).not.toHaveBeenCalled();
  });

  it("rejects enrolled-loop daemon events without v2 envelope even when capability header is missing", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.error).toBe("enrolled_loop_requires_v2_envelope");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("requires v2 envelopes for enrolled loops even without capability headers", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
      }),
    );

    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.error).toBe("enrolled_loop_requires_v2_envelope");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
    expect(dbMocks.insert).not.toHaveBeenCalled();
  });

  it("accepts enrolled-loop daemon events with v2 envelope", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      state: "planning",
      loopVersion: 11,
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-1",
        runId: "run-1",
        seq: 1,
      }),
    );

    expect(response.status).toBe(200);
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
    expect(dbMocks.transaction).toHaveBeenCalledTimes(1);
    expect(dbMocks.execute).toHaveBeenCalledTimes(1);
    expect(dbMocks.update).toHaveBeenCalledTimes(1);
  });

  it("does not force implementation transition when enrolled loop has already advanced state", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      state: "blocked",
      loopVersion: 11,
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-non-enrolled",
        runId: "run-1",
        seq: 2,
      }),
    );

    expect(response.status).toBe(200);
  });

  it("rolls back the claimed v2 signal when daemon handling fails so retries can process the message", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);
    vi.mocked(handleDaemonEvent)
      .mockResolvedValueOnce({
        success: false,
        error: "temporary failure",
        status: 503,
      })
      .mockResolvedValue({ success: true });

    let eventClaimed = false;
    let selectCallCount = 0;
    dbMocks.selectWhere.mockImplementation(async () => {
      selectCallCount += 1;
      const isExistingSignalCheck = selectCallCount % 2 === 1;
      if (isExistingSignalCheck) {
        return eventClaimed ? [{ id: "signal-existing" }] : [];
      }
      return [{ maxSeq: null }];
    });
    dbMocks.insertReturning.mockImplementation(async () => {
      if (eventClaimed) {
        return [];
      }
      eventClaimed = true;
      return [{ id: "signal-1" }];
    });
    dbMocks.deleteReturning.mockImplementation(async () => {
      eventClaimed = false;
      return [{ id: "signal-1" }];
    });

    const firstResponse = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-rollback",
        runId: "run-1",
        seq: 7,
      }),
    );
    expect(firstResponse.status).toBe(503);
    expect(dbMocks.deleteFrom).toHaveBeenCalledTimes(1);

    const secondResponse = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-rollback",
        runId: "run-1",
        seq: 7,
      }),
    );

    expect(secondResponse.status).toBe(200);
    expect(handleDaemonEvent).toHaveBeenCalledTimes(2);
  });

  it("deduplicates repeated daemon envelopes by event identity", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);
    dbMocks.selectWhere.mockResolvedValueOnce([
      {
        id: "signal-existing",
        receivedAt: new Date("2026-01-01T00:00:00.000Z"),
        processedAt: new Date("2026-01-01T00:01:00.000Z"),
      },
    ]);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-duplicate",
        runId: "run-1",
        seq: 2,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.reason).toBe("duplicate_event");
    expect(data.acknowledgedEventId).toBe("event-duplicate");
    expect(data.acknowledgedSeq).toBe(2);
    expect(handleDaemonEvent).not.toHaveBeenCalled();
    expect(dbMocks.insert).not.toHaveBeenCalled();
    expect(dispatchIntentMocks.updateDispatchIntent).toHaveBeenCalledWith(
      "di_loop-1_run-1",
      "chat-1",
      {
        status: "completed",
        lastError: null,
        lastFailureCategory: null,
      },
    );
    expect(markDispatchIntentCompleted).toHaveBeenCalledWith(
      expect.anything(),
      "run-1",
    );
    expect(getThreadChat).not.toHaveBeenCalled();
    expect(maybeProcessFollowUpQueue).not.toHaveBeenCalled();
  });

  it("returns a retryable conflict instead of deduping when the same daemon event claim is still in progress", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);
    dbMocks.selectWhere.mockResolvedValueOnce([
      {
        id: "signal-in-progress",
        receivedAt: new Date(),
        processedAt: null,
      },
    ]);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-in-progress",
        runId: "run-1",
        seq: 9,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.error).toBe("daemon_event_claim_in_progress");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("reclaims stale unprocessed daemon-event claims so the event is replayed", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);
    dbMocks.selectWhere.mockResolvedValueOnce([
      {
        id: "signal-stale",
        receivedAt: new Date(Date.now() - 30 * 60 * 1000),
        committedAt: null,
        processedAt: null,
      },
    ]);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-stale-claim",
        runId: "run-1",
        seq: 10,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
    expect(dbMocks.deleteFrom).toHaveBeenCalledTimes(1);
    expect(dbMocks.update).toHaveBeenCalledTimes(1);
  });

  it("deduplicates stale committed daemon-event claims without reclaiming or replaying", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);
    dbMocks.selectWhere.mockResolvedValueOnce([
      {
        id: "signal-committed",
        receivedAt: new Date(Date.now() - 30 * 60 * 1000),
        committedAt: new Date(Date.now() - 20 * 60 * 1000),
        processedAt: null,
      },
    ]);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-committed",
        runId: "run-1",
        seq: 11,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.reason).toBe("duplicate_event");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
    expect(dbMocks.deleteFrom).not.toHaveBeenCalled();
    expect(dbMocks.update).not.toHaveBeenCalled();
  });

  it("treats commit as idempotent success when another worker already committed the signal", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);
    dbMocks.updateReturning.mockResolvedValueOnce([]);
    dbMocks.signalInboxFindFirst.mockResolvedValueOnce({
      id: "signal-1",
      committedAt: new Date("2026-01-01T00:01:00.000Z"),
      processedAt: null,
    });

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-committed-elsewhere",
        runId: "run-1",
        seq: 12,
      }),
    );

    expect(response.status).toBe(200);
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
  });

  it("deduplicates out-of-order daemon envelopes within the same run", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);
    dbMocks.selectWhere
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ maxSeq: 4 }]);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-out-of-order",
        runId: "run-1",
        seq: 3,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.reason).toBe("out_of_order_or_duplicate_seq");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
    expect(dbMocks.insert).not.toHaveBeenCalled();
    expect(dispatchIntentMocks.updateDispatchIntent).toHaveBeenCalledWith(
      "di_loop-1_run-1",
      "chat-1",
      {
        status: "completed",
        lastError: null,
        lastFailureCategory: null,
      },
    );
    expect(markDispatchIntentCompleted).toHaveBeenCalledWith(
      expect.anything(),
      "run-1",
    );
  });

  it("deduplicates concurrent claim races by event identity when insert conflicts", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);
    dbMocks.selectWhere
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ maxSeq: null }]);
    dbMocks.insertReturning.mockResolvedValue([]);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-raced",
        runId: "run-1",
        seq: 5,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.reason).toBe("duplicate_event");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });
});
