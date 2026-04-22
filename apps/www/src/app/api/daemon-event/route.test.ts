import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { getDaemonTokenAuthContextOrNull } from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import {
  createDispatchIntent as createDurableDispatchIntent,
  markDispatchIntentCompleted,
  markDispatchIntentDispatched,
  markDispatchIntentFailed,
} from "@terragon/shared/delivery-loop/store/dispatch-intent-store";
import {
  getAgentRunContextByRunId,
  updateAgentRunContext,
} from "@terragon/shared/model/agent-run-context";
import {
  getThreadMinimal,
  getThreadChat,
  touchThreadChatUpdatedAt,
  updateThreadChatTerminalMetadataIfTerminal,
} from "@terragon/shared/model/threads";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { maybeProcessFollowUpQueue } from "@/server-lib/process-follow-up-queue";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import {
  DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
  DAEMON_EVENT_CAPABILITIES_HEADER,
} from "@terragon/daemon/shared";
import { getActiveWorkflowForThread } from "@terragon/shared/delivery-loop/store/workflow-store";
import { assignThreadChatMessageSeqToCanonicalEvents } from "@terragon/shared/model/agent-event-log";
import { publishBroadcastUserMessage } from "@terragon/shared/broadcast-server";
import { persistAndPublishAgUiEvents } from "@/server-lib/ag-ui-publisher";
import { env } from "@terragon/env/apps-www";
import { extendSandboxLife } from "@terragon/sandbox";
import { getDaemonEventDbPreflight } from "@/server-lib/daemon-event-db-preflight";

const LEGACY_THREAD_CHAT_ID = "legacy-thread-chat-id";

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
  markDispatchIntentDispatched: vi.fn(),
  markDispatchIntentCompleted: vi.fn(),
  markDispatchIntentFailed: vi.fn(),
}));

const canonicalEventLogMocks = vi.hoisted(() => ({
  assignThreadChatMessageSeqToCanonicalEvents: vi.fn(),
}));

const agUiPublisherMocks = vi.hoisted(() => ({
  persistAndPublishAgUiEvents: vi.fn(),
  broadcastAgUiEventEphemeral: vi.fn(),
  canonicalEventsToAgUiRows: vi.fn((events: Array<{ eventId: string }>) =>
    // Test-only stub — the route under test does not consume this result
    // (the publisher does). Keep the signature shape only for completeness.
    events.map((e) => ({
      event: { type: "STUB" } as unknown,
      eventId: `${e.eventId}:STUB:0`,
      timestamp: new Date(),
    })),
  ),
  daemonDeltasToAgUiRows: vi.fn(() => []),
  dbAgentMessagePartsToAgUiRows: vi.fn(() => []),
  metaEventsToAgUiEvents: vi.fn(() => []),
  buildRunTerminalAgUi: vi.fn(() => ({ type: "RUN_FINISHED" })),
  buildAgUiEventId: vi.fn(
    (canonicalEventId: string, agUiType: string, index: number) =>
      `${canonicalEventId}:${agUiType}:${index}`,
  ),
}));

const v3BridgeMocks = vi.hoisted(() => ({
  appendEventAndAdvance: vi.fn(),
  appendEventAndAdvanceExplicit: vi.fn(),
  getWorkflowHead: vi.fn(),
  getActiveWorkflowForThread: vi.fn(),
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

vi.mock("@terragon/shared/delivery-loop/store/dispatch-intent-store", () => ({
  createDispatchIntent: deliveryLoopModelMocks.createDispatchIntent,
  markDispatchIntentDispatched:
    deliveryLoopModelMocks.markDispatchIntentDispatched,
  markDispatchIntentCompleted:
    deliveryLoopModelMocks.markDispatchIntentCompleted,
  markDispatchIntentFailed: deliveryLoopModelMocks.markDispatchIntentFailed,
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
  touchThreadChatUpdatedAt: vi.fn(),
  updateThreadChat: vi.fn(),
  updateThreadChatTerminalMetadataIfTerminal: vi.fn(),
}));

vi.mock("@terragon/sandbox", () => ({
  extendSandboxLife: vi.fn().mockResolvedValue(undefined),
}));

// Mock update-status to isolate the route from the real thread state-machine logic.
vi.mock("@/agent/update-status", () => ({
  updateThreadChatWithTransition: vi.fn(),
}));

vi.mock("@terragon/shared/delivery-loop/store/workflow-store", () => ({
  getActiveWorkflowForThread: vi.fn().mockResolvedValue(null),
}));

vi.mock("@terragon/shared/model/agent-event-log", () => ({
  assignThreadChatMessageSeqToCanonicalEvents:
    canonicalEventLogMocks.assignThreadChatMessageSeqToCanonicalEvents,
}));

vi.mock("@/server-lib/ag-ui-publisher", () => agUiPublisherMocks);

vi.mock("@terragon/shared/broadcast-server", () => ({
  publishBroadcastUserMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server-lib/delivery-loop/v3/kernel", () => ({
  appendEventAndAdvance: v3BridgeMocks.appendEventAndAdvance,
  appendEventAndAdvanceExplicit: v3BridgeMocks.appendEventAndAdvance,
}));

vi.mock("@/server-lib/delivery-loop/v3/store", () => ({
  getWorkflowHead: v3BridgeMocks.getWorkflowHead,
  getActiveWorkflowForThread: v3BridgeMocks.getActiveWorkflowForThread,
}));

vi.mock("@/server-lib/daemon-event-db-preflight", () => ({
  getDaemonEventDbPreflight: vi.fn(),
}));

const redisMocks = vi.hoisted(() => {
  const pipelineSet = vi.fn();
  const pipelineDel = vi.fn();
  const pipelineExec = vi.fn().mockResolvedValue([]);
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    pipeline: vi.fn(() => ({
      set: pipelineSet,
      del: pipelineDel,
      exec: pipelineExec,
    })),
    pipelineSet,
    pipelineDel,
    pipelineExec,
  };
});

vi.mock("@/lib/redis", () => ({
  redis: redisMocks,
  isLocalRedisHttpMode: vi.fn().mockReturnValue(false),
  isRedisTransportParseError: vi.fn().mockReturnValue(false),
}));

vi.mock("@/server-lib/delivery-loop/ack-lifecycle", () => ({
  handleAckReceived: vi.fn().mockResolvedValue(undefined),
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

function createCanonicalRunStartedEvent(
  overrides: Record<string, unknown> = {},
) {
  return {
    payloadVersion: 2,
    eventId: "canonical-event-1",
    runId: "run-1",
    threadId: "thread-1",
    threadChatId: "chat-1",
    seq: 0,
    timestamp: "2026-04-19T20:00:00.000Z",
    category: "operational",
    type: "run-started",
    agent: "codex",
    model: "gpt-5.4",
    transportMode: "acp",
    protocolVersion: 2,
    ...overrides,
  };
}

function createCanonicalRunTerminalEvent(
  overrides: Record<string, unknown> = {},
) {
  return {
    payloadVersion: 2,
    eventId: "canonical-terminal-1",
    runId: "run-1",
    threadId: "thread-1",
    threadChatId: "chat-1",
    seq: 99,
    timestamp: "2026-04-19T20:00:01.000Z",
    category: "operational",
    type: "run-terminal",
    status: "completed",
    errorMessage: null,
    errorCode: null,
    headShaAtCompletion: null,
    ...overrides,
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
    vi.mocked(getThreadChat).mockResolvedValue({
      id: "chat-1",
      threadId: "thread-1",
      userId: "user-1",
      status: "working",
      messages: [],
      queuedMessages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.mocked(createDurableDispatchIntent).mockResolvedValue(
      "durable-dispatch-intent-1",
    );
    vi.mocked(markDispatchIntentDispatched).mockResolvedValue(undefined);
    vi.mocked(markDispatchIntentCompleted).mockResolvedValue(undefined);
    vi.mocked(markDispatchIntentFailed).mockResolvedValue(undefined);
    vi.mocked(handleDaemonEvent).mockResolvedValue({
      success: true,
      threadChatMessageSeq: null,
    });
    vi.mocked(updateThreadChatWithTransition).mockResolvedValue({
      didUpdateStatus: true,
      updatedStatus: "working-done",
      chatSequence: undefined,
    });
    vi.mocked(updateThreadChatTerminalMetadataIfTerminal).mockResolvedValue({
      didUpdate: true,
    });
    vi.mocked(maybeProcessFollowUpQueue).mockResolvedValue({
      processed: false,
      dispatchLaunched: false,
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
    v3BridgeMocks.appendEventAndAdvance.mockResolvedValue(undefined);
    v3BridgeMocks.getWorkflowHead.mockResolvedValue(null);
    v3BridgeMocks.getActiveWorkflowForThread.mockImplementation(
      async ({ threadId }: { threadId: string }) => {
        const workflow = await vi.mocked(getActiveWorkflowForThread)({
          db: dbMocks.db as never,
          threadId,
        });
        return workflow
          ? {
              workflow,
              head: {
                state:
                  workflow.kind === "planning" ? "planning" : "implementing",
              },
            }
          : null;
      },
    );
    dbMocks.execute.mockResolvedValue({ rows: [] });
    dbMocks.selectWhere.mockResolvedValue([]);
    dbMocks.insertReturning.mockResolvedValue([{ id: "signal-1" }]);
    dbMocks.deleteReturning.mockResolvedValue([{ id: "signal-1" }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: "signal-1" }]);
    dbMocks.signalInboxFindFirst.mockResolvedValue(null);
    vi.mocked(getThreadMinimal).mockResolvedValue({
      id: "thread-1",
      userId: "user-1",
      codesandboxId: null,
      sandboxProvider: null,
    } as unknown as Awaited<ReturnType<typeof getThreadMinimal>>);
    vi.mocked(touchThreadChatUpdatedAt).mockResolvedValue(undefined);
    vi.mocked(extendSandboxLife).mockResolvedValue(undefined);
    vi.mocked(getDaemonEventDbPreflight).mockResolvedValue({
      agentEventLogReady: true,
      agentRunContextFailureColumnsReady: true,
      missing: [],
    });
    agUiPublisherMocks.persistAndPublishAgUiEvents.mockResolvedValue({
      inserted: 0,
      skipped: 0,
      insertedEventIds: [],
    });
    agUiPublisherMocks.broadcastAgUiEventEphemeral.mockResolvedValue(undefined);
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

  it("accepts daemon-event requests with test auth in non-production", async () => {
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue(null);

    const response = await POST(
      createDaemonRequest(
        {
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-test-auth",
          runId: "run-1",
          seq: 0,
        },
        {
          "X-Terragon-Test-Daemon-Auth": "enabled",
          "X-Terragon-Secret": env.INTERNAL_SHARED_SECRET,
          "X-Terragon-Test-User-Id": "user-1",
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        success: true,
        acknowledgedEventId: "event-test-auth",
        acknowledgedSeq: 0,
      }),
    );
    expect(handleDaemonEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        runId: "run-1",
      }),
    );
  });

  it("rejects daemon-event test auth when secret is invalid", async () => {
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue(null);

    const response = await POST(
      createDaemonRequest(
        {
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          timezone: "UTC",
        },
        {
          "X-Terragon-Test-Daemon-Auth": "enabled",
          "X-Terragon-Secret": "invalid",
          "X-Terragon-Test-User-Id": "user-1",
        },
      ),
    );

    expect(response.status).toBe(401);
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("does not bypass daemon-token auth when X-Daemon-Token is present", async () => {
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue(null);

    const response = await POST(
      createDaemonRequest(
        {
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-token-present",
          runId: "run-1",
          seq: 0,
        },
        {
          "X-Daemon-Token": "invalid-token",
          "X-Terragon-Test-Daemon-Auth": "enabled",
          "X-Terragon-Secret": env.INTERNAL_SHARED_SECRET,
          "X-Terragon-Test-User-Id": "user-1",
        },
      ),
    );

    expect(response.status).toBe(401);
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("rejects test auth path in production even with valid test headers", async () => {
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue(null);
    vi.stubEnv("NODE_ENV", "production");

    try {
      const response = await POST(
        createDaemonRequest(
          {
            threadId: "thread-1",
            threadChatId: "chat-1",
            messages: [createSuccessResultMessage()],
            timezone: "UTC",
          },
          {
            "X-Terragon-Test-Daemon-Auth": "enabled",
            "X-Terragon-Secret": env.INTERNAL_SHARED_SECRET,
            "X-Terragon-Test-User-Id": "user-1",
          },
        ),
      );

      expect(response.status).toBe(401);
      expect(handleDaemonEvent).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("routes daemon deltas through the AG-UI publisher", async () => {
    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        payloadVersion: 2,
        eventId: "event-1",
        runId: "run-1",
        seq: 8,
        messages: [],
        deltas: [
          {
            messageId: "m",
            partIndex: 0,
            deltaSeq: 10,
            kind: "text",
            text: "a",
          },
          {
            messageId: "m",
            partIndex: 0,
            deltaSeq: 11,
            kind: "text",
            text: "b",
          },
        ],
        timezone: "UTC",
      }),
    );

    expect(response.status).toBe(200);
    expect(agUiPublisherMocks.daemonDeltasToAgUiRows).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        deltas: expect.arrayContaining([
          expect.objectContaining({ messageId: "m", deltaSeq: 10 }),
          expect.objectContaining({ messageId: "m", deltaSeq: 11 }),
        ]),
      }),
    );
    expect(persistAndPublishAgUiEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
      }),
    );
  });

  it("emits AG-UI rich-part events for assistant messages with thinking blocks", async () => {
    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        payloadVersion: 2,
        eventId: "event-rich-1",
        runId: "run-1",
        seq: 1,
        messages: [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "pondering" },
                { type: "text", text: "final answer" },
              ],
            },
            session_id: "s-1",
            parent_tool_use_id: null,
          },
        ],
        timezone: "UTC",
      }),
    );

    expect(response.status).toBe(200);
    // dbAgentMessagePartsToAgUiRows receives one rich assistant message with
    // a stable messageId derived from the envelope's eventId + the running
    // dbMessage index.
    expect(
      agUiPublisherMocks.dbAgentMessagePartsToAgUiRows,
    ).toHaveBeenCalledTimes(1);
    const call = agUiPublisherMocks.dbAgentMessagePartsToAgUiRows.mock
      .calls[0] as unknown as [
      Array<{ messageId: string; parts: Array<{ type: string }> }>,
    ];
    const inputs = call[0];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.messageId).toMatch(/^event-rich-1:msg:\d+$/);
    // Parts should include the thinking block; the text block is retained in
    // the DBAgentMessage parts array but the mapper itself skips pure text.
    const partTypes = inputs[0]!.parts.map((p) => p.type);
    expect(partTypes).toContain("thinking");
  });

  it("skips rich-part emission when assistant message has only text parts", async () => {
    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        payloadVersion: 2,
        eventId: "event-text-only",
        runId: "run-1",
        seq: 1,
        messages: [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: "just text, nothing rich",
            },
            session_id: "s-1",
            parent_tool_use_id: null,
          },
        ],
        timezone: "UTC",
      }),
    );

    expect(response.status).toBe(200);
    expect(
      agUiPublisherMocks.dbAgentMessagePartsToAgUiRows,
    ).not.toHaveBeenCalled();
  });

  it("rejects enrolled-loop daemon events without v2 envelope when daemon advertises v2 capability", async () => {
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

  it("rejects legacy daemon payloads with the legacy threadChat sentinel", async () => {
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

    expect(response.status).toBe(400);
    expect(data.error).toBe("daemon_event_non_legacy_requires_thread_chat_id");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
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

  it("persists canonical events before returning run_terminal_ignored", async () => {
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
    agUiPublisherMocks.persistAndPublishAgUiEvents.mockResolvedValue({
      inserted: 1,
      skipped: 0,
      insertedEventIds: ["canonical-event-1:RUN_STARTED:0"],
    });

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [],
        canonicalEvents: [createCanonicalRunStartedEvent()],
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
    expect(persistAndPublishAgUiEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
      }),
    );
    expect(
      agUiPublisherMocks.persistAndPublishAgUiEvents.mock
        .invocationCallOrder[0] ?? 0,
    ).toBeLessThan(
      dispatchIntentMocks.getReplayableSelfDispatch.mock
        .invocationCallOrder[0] ?? Infinity,
    );
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

  // VAL-API-011: Run-id claim mismatch rejection
  it("rejects daemon-event with run-id claim mismatch with 401 auth error", async () => {
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue({
      userId: "user-1",
      keyId: "api-key-1",
      claims: {
        kind: "daemon-run",
        runId: "run-claimed-1",
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
      runId: "run-claimed-1",
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

    // Send request with envelope runId that does NOT match the token claims runId
    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-mismatch",
        runId: "run-different-2", // Different from claims.runId
        seq: 0,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe("daemon_event_run_id_claim_mismatch");
    expect(data.runId).toBe("run-different-2");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  // VAL-API-012: Missing/expired daemon claims rejection
  it("rejects daemon-event with missing token claims with 401 auth error", async () => {
    // Return auth context but with null claims (simulating missing claims)
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue({
      userId: "user-1",
      keyId: "api-key-1",
      claims: null, // Missing claims
    } as any);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-no-claims",
        runId: "run-1",
        seq: 0,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe("daemon_token_claims_required");
    expect(data.runId).toBe("run-1");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("rejects daemon-event with expired token claims with 401 auth error", async () => {
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
        issuedAt: Date.now() - 120_000, // Issued 2 minutes ago
        exp: Date.now() - 60_000, // Expired 1 minute ago
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

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-expired",
        runId: "run-1",
        seq: 0,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe("daemon_token_expired");
    expect(data.runId).toBe("run-1");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  // VAL-API-013: Run-context mismatch conflict rejection
  it("rejects daemon-event with run-context mismatch with 409 conflict error", async () => {
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
    // Run context has different threadId than the request
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
      runId: "run-1",
      userId: "user-1",
      threadId: "thread-different", // Different from request threadId
      threadChatId: "chat-different", // Different from request threadChatId
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

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1", // Different from runContext.threadId
        threadChatId: "chat-1", // Different from runContext.threadChatId
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-mismatch",
        runId: "run-1",
        seq: 0,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.error).toBe("daemon_event_run_context_mismatch");
    expect(data.runId).toBe("run-1");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  // VAL-API-014: Pure-v2 terminal events bridge exactly once to canonical v3 transition
  it("bridges pure-v2 terminal daemon event to v3 kernel exactly once", async () => {
    vi.mocked(getActiveWorkflowForThread).mockResolvedValue({
      id: "wf-pure-v2",
      threadId: "thread-1",
      kind: "implementing",
      generation: 1,
    } as Awaited<ReturnType<typeof getActiveWorkflowForThread>>);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
      runId: "run-1",
      workflowId: "wf-pure-v2",
      runSeq: 5,
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
      status: "processing",
      tokenNonce: "nonce-1",
      daemonTokenKeyId: "api-key-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);
    v3BridgeMocks.getWorkflowHead.mockResolvedValue({
      state: "implementing",
      activeRunId: "run-1",
      activeRunSeq: 5,
    });
    // Simulate first-time insertion success
    v3BridgeMocks.appendEventAndAdvance.mockResolvedValue({
      inserted: true,
      transitioned: true,
      effectsInserted: 2,
      stateBefore: "implementing",
      stateAfter: "gating_review",
    });

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-terminal-v3",
        runId: "run-1",
        seq: 10,
        headShaAtCompletion: "sha-123",
      }),
    );

    expect(response.status).toBe(200);
    // v3 kernel bridge should be called exactly once for the first terminal event
    expect(v3BridgeMocks.appendEventAndAdvance).toHaveBeenCalledTimes(1);
    expect(v3BridgeMocks.appendEventAndAdvance).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-pure-v2",
        source: "daemon",
        idempotencyKey: "run-completed:event-terminal-v3",
        event: expect.objectContaining({
          type: "run_completed",
          runId: "run-1",
          runSeq: 5,
          headSha: "sha-123",
        }),
      }),
    );
  });

  it("deduplicates replay of pure-v2 terminal daemon event without duplicate v3 side effects", async () => {
    vi.mocked(getActiveWorkflowForThread).mockResolvedValue({
      id: "wf-pure-v2",
      threadId: "thread-1",
      kind: "implementing",
      generation: 1,
    } as Awaited<ReturnType<typeof getActiveWorkflowForThread>>);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
      runId: "run-1",
      workflowId: "wf-pure-v2",
      runSeq: 5,
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
      status: "completed", // Terminal status
      tokenNonce: "nonce-1",
      daemonTokenKeyId: "api-key-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);
    v3BridgeMocks.getWorkflowHead.mockResolvedValue({
      state: "gating_review", // Already transitioned
      activeRunId: null,
      activeRunSeq: null,
    });

    // First request - should be deduplicated due to run_terminal_ignored
    const firstResponse = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-terminal-dup",
        runId: "run-1",
        seq: 10,
        headShaAtCompletion: "sha-123",
      }),
    );

    expect(firstResponse.status).toBe(202);
    expect(firstResponse.json()).resolves.toMatchObject({
      reason: "run_terminal_ignored",
      deduplicated: true,
    });
    // v3 bridge should NOT be called for terminal runs (they're filtered before bridge)
    expect(v3BridgeMocks.appendEventAndAdvance).not.toHaveBeenCalled();

    // Second request (out-of-order replay) - also deduplicated
    const secondResponse = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-terminal-dup",
        runId: "run-1",
        seq: 9, // Out of order sequence
        headShaAtCompletion: "sha-123",
      }),
    );

    expect(secondResponse.status).toBe(202);
    // v3 bridge still should not be called
    expect(v3BridgeMocks.appendEventAndAdvance).not.toHaveBeenCalled();
  });

  // Removed: "re-enqueues daemon-terminal feedback" — v1 follow-up re-enqueue
  // logic was removed; v2 handles dispatch via work items.

  it("replays self-dispatch on duplicate terminal acknowledgements", async () => {
    // In v2, duplicate terminal acks are handled via run_terminal_ignored
    // (runContext.status === "completed" → 202 before dedup/claim).
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
        eventId: "event-dup-terminal",
        runId: "run-1",
        seq: 3,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.deduplicated).toBe(true);
    expect(data.reason).toBe("run_terminal_ignored");
    expect(data.selfDispatch).toEqual(
      expect.objectContaining({
        runId: "run-next",
      }),
    );
  });

  it("replays self-dispatch on out-of-order terminal acknowledgements", async () => {
    // In v2, out-of-order terminal acks are handled via run_terminal_ignored
    // (runContext.status === "completed" → 202 before any seq check).
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
        eventId: "event-out-of-order",
        runId: "run-1",
        seq: 2,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.deduplicated).toBe(true);
    expect(data.reason).toBe("run_terminal_ignored");
    expect(data.selfDispatch).toEqual(
      expect.objectContaining({
        runId: "run-next",
      }),
    );
  });

  it("blocks auto-dispatch when consecutive completed runs exceed threshold", async () => {
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
        payloadVersion: 2,
        eventId: "event-codex-1",
        runId: "run-1",
        seq: 0,
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
        payloadVersion: 2,
        eventId: "event-codex-invalid",
        runId: "run-1",
        seq: 0,
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
    vi.mocked(getActiveWorkflowForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      kind: "implementing",
      generation: 1,
    } as Awaited<ReturnType<typeof getActiveWorkflowForThread>>);
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
    vi.mocked(getActiveWorkflowForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      kind: "implementing",
      generation: 1,
    } as Awaited<ReturnType<typeof getActiveWorkflowForThread>>);
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
    vi.mocked(getActiveWorkflowForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      kind: "implementing",
      generation: 1,
    } as Awaited<ReturnType<typeof getActiveWorkflowForThread>>);
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
  });

  // VAL-CROSS-002: Duplicate ingress across API and runtime remains idempotent
  describe("duplicate ingress idempotency (VAL-CROSS-002)", () => {
    it("deduplicates duplicate daemon ingress to prevent duplicate logical transitions", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue({
        id: "wf-dedup-test",
        threadId: "thread-1",
        kind: "implementing",
        generation: 1,
      } as Awaited<ReturnType<typeof getActiveWorkflowForThread>>);
      // Align auth claims with envelope runId to avoid claim mismatch
      vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue({
        userId: "user-1",
        keyId: "api-key-1",
        claims: {
          kind: "daemon-run",
          runId: "run-dedup-1",
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
        runId: "run-dedup-1",
        workflowId: "wf-dedup-test",
        runSeq: 3,
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
        status: "processing",
        tokenNonce: "nonce-1",
        daemonTokenKeyId: "api-key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);

      // Use non-terminal messages to trigger claim logic path
      const nonTerminalMessage = {
        type: "assistant",
        message: { content: "working" },
        session_id: "s-1",
        parent_tool_use_id: null,
      };

      // First ingress - claim succeeds, processing completes
      redisMocks.get.mockResolvedValueOnce(null); // not committed
      redisMocks.set.mockResolvedValueOnce("OK"); // claim succeeds

      const firstResponse = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [nonTerminalMessage],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-dedup-test",
          runId: "run-dedup-1",
          seq: 5,
        }),
      );

      expect(firstResponse.status).toBe(200);
      expect(handleDaemonEvent).toHaveBeenCalledTimes(1);

      // Second ingress (duplicate) - committed key now present
      redisMocks.get.mockResolvedValueOnce(new Date().toISOString()); // already committed

      const secondResponse = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [nonTerminalMessage],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-dedup-test", // Same eventId
          runId: "run-dedup-1",
          seq: 5,
        }),
      );

      expect(secondResponse.status).toBe(202);
      const secondData = await secondResponse.json();
      expect(secondData.reason).toBe("duplicate_event");
      expect(secondData.deduplicated).toBe(true);

      // Handler should only be called once total
      expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
    });

    it("handles in-progress claim conflict without duplicate processing", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue({
        id: "loop-dedup",
        threadId: "thread-1",
        kind: "implementing",
        generation: 1,
      } as Awaited<ReturnType<typeof getActiveWorkflowForThread>>);

      // Simulate another worker has the claim (set returns null)
      redisMocks.get.mockResolvedValueOnce(null); // not committed
      redisMocks.set.mockResolvedValueOnce(null); // claim fails - another worker has it
      redisMocks.get.mockResolvedValueOnce(null); // still not committed

      // Use non-terminal message to trigger claim logic path
      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [
            {
              type: "assistant",
              message: { content: "working" },
              session_id: "s-1",
              parent_tool_use_id: null,
            },
          ],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-in-progress-dedup",
          runId: "run-1", // Matches default beforeEach claims
          seq: 0,
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error).toBe("daemon_event_claim_in_progress");
      expect(handleDaemonEvent).not.toHaveBeenCalled();
    });
  });

  it("does not force implementation transition when enrolled loop has already advanced state", async () => {
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
    vi.mocked(getActiveWorkflowForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      kind: "implementing",
      generation: 1,
    } as Awaited<ReturnType<typeof getActiveWorkflowForThread>>);
    // Align auth claims with envelope runId to avoid claim mismatch
    vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue({
      userId: "user-1",
      keyId: "api-key-1",
      claims: {
        kind: "daemon-run",
        runId: "run-rollback-test",
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
      runId: "run-rollback-test",
      workflowId: "loop-1",
      runSeq: 7,
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
      status: "processing",
      tokenNonce: "nonce-1",
      daemonTokenKeyId: "api-key-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);
    vi.mocked(handleDaemonEvent)
      .mockResolvedValueOnce({
        success: false,
        error: "temporary failure",
        status: 503,
      })
      .mockResolvedValue({
        success: true,
        threadChatMessageSeq: null,
      });

    // First request: claim succeeds (set returns "OK"), handleDaemonEvent fails
    // Second request: claim succeeds again (set returns "OK"), handleDaemonEvent succeeds
    redisMocks.set.mockResolvedValue("OK");
    redisMocks.get.mockResolvedValue(null);

    const firstResponse = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [
          {
            type: "assistant",
            message: { content: "working" },
            session_id: "s-1",
            parent_tool_use_id: null,
          },
        ],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-rollback",
        runId: "run-rollback-test",
        seq: 7,
      }),
    );
    expect(firstResponse.status).toBe(503);
    // Redis del called to rollback the processing event claim
    expect(redisMocks.del).toHaveBeenCalledTimes(1);

    const secondResponse = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [
          {
            type: "assistant",
            message: { content: "working" },
            session_id: "s-1",
            parent_tool_use_id: null,
          },
        ],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-rollback",
        runId: "run-rollback-test",
        seq: 7,
      }),
    );

    expect(secondResponse.status).toBe(200);
    expect(handleDaemonEvent).toHaveBeenCalledTimes(2);
  });

  it("deduplicates repeated daemon envelopes by event identity", async () => {
    vi.mocked(getActiveWorkflowForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      kind: "implementing",
      generation: 1,
    } as Awaited<ReturnType<typeof getActiveWorkflowForThread>>);
    // Simulate committed key already set in Redis → duplicate_event (202)
    redisMocks.get.mockResolvedValueOnce(
      new Date("2026-01-01T00:01:00.000Z").toISOString(),
    );

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [
          {
            type: "assistant",
            message: { content: "working" },
            session_id: "s-1",
            parent_tool_use_id: null,
          },
        ],
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
  });

  it("returns a retryable conflict instead of deduping when the same daemon event claim is still in progress", async () => {
    vi.mocked(getActiveWorkflowForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      kind: "implementing",
      generation: 1,
    } as Awaited<ReturnType<typeof getActiveWorkflowForThread>>);
    // No committed key yet, but set (claim attempt) fails → another worker holds the claim
    redisMocks.get.mockResolvedValueOnce(null); // committedKey check 1: not committed
    redisMocks.set.mockResolvedValueOnce(null); // claim attempt fails
    redisMocks.get.mockResolvedValueOnce(null); // committedKey check 2: still not committed

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [
          {
            type: "assistant",
            message: { content: "working" },
            session_id: "s-1",
            parent_tool_use_id: null,
          },
        ],
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
    vi.mocked(getActiveWorkflowForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      kind: "implementing",
      generation: 1,
    } as Awaited<ReturnType<typeof getActiveWorkflowForThread>>);
    // No committed key → claim succeeds → event is processed normally
    redisMocks.get.mockResolvedValueOnce(null);
    redisMocks.set.mockResolvedValueOnce("OK");

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [
          {
            type: "assistant",
            message: { content: "working" },
            session_id: "s-1",
            parent_tool_use_id: null,
          },
        ],
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
  });

  it("deduplicates stale committed daemon-event claims without reclaiming or replaying", async () => {
    vi.mocked(getActiveWorkflowForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      kind: "implementing",
      generation: 1,
    } as Awaited<ReturnType<typeof getActiveWorkflowForThread>>);
    // Committed key present → duplicate_event (202)
    redisMocks.get.mockResolvedValueOnce(
      new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    );

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [
          {
            type: "assistant",
            message: { content: "working" },
            session_id: "s-1",
            parent_tool_use_id: null,
          },
        ],
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
  });

  it("treats commit as idempotent success when another worker already committed the signal", async () => {
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
    // In v2, processing-event dedup uses Redis committed key.
    // An out-of-order (already committed) event looks the same as a duplicate.
    vi.mocked(getActiveWorkflowForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      kind: "implementing",
      generation: 1,
    } as Awaited<ReturnType<typeof getActiveWorkflowForThread>>);
    // Committed key present → duplicate_event (202)
    redisMocks.get.mockResolvedValueOnce(new Date().toISOString());

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [
          {
            type: "assistant",
            message: { content: "working" },
            session_id: "s-1",
            parent_tool_use_id: null,
          },
        ],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-out-of-order",
        runId: "run-1",
        seq: 3,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.reason).toBe("duplicate_event");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent claim races by event identity when insert conflicts", async () => {
    // In v2, a concurrent race means the claim set fails (not "OK") but
    // committed key becomes present before us → duplicate_event (202).
    vi.mocked(getActiveWorkflowForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      kind: "implementing",
      generation: 1,
    } as Awaited<ReturnType<typeof getActiveWorkflowForThread>>);
    redisMocks.get.mockResolvedValueOnce(null); // committed check 1: not committed yet
    redisMocks.set.mockResolvedValueOnce(null); // claim attempt loses the race
    redisMocks.get.mockResolvedValueOnce(new Date().toISOString()); // committed check 2: winner committed

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [
          {
            type: "assistant",
            message: { content: "working" },
            session_id: "s-1",
            parent_tool_use_id: null,
          },
        ],
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

  describe("pure v2 workflow", () => {
    const PURE_V2_WORKFLOW = {
      id: "wf-pure-v2",
      threadId: "thread-1",
      kind: "planning",
      generation: 1,
    };

    it("routes pure v2 terminal event through v3 kernel bridge", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          headShaAtCompletion: "abc123def456",
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-1",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
      expect(handleDaemonEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          deferTerminalTransitionToRoute: true,
        }),
      );
      expect(updateThreadChatWithTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          threadChatId: "chat-1",
          userId: "user-1",
          eventType: "assistant.message_done",
          requireStatusTransitionForChatUpdates: true,
          skipBroadcast: true,
        }),
      );
      expect(updateThreadChatTerminalMetadataIfTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          threadChatId: "chat-1",
          userId: "user-1",
          updates: {
            errorMessage: null,
            errorMessageInfo: null,
          },
        }),
      );
      expect(updateAgentRunContext).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          userId: "user-1",
          updates: expect.objectContaining({
            status: "completed",
          }),
        }),
      );
    });

    it("fences mixed terminal batches (assistant + result) through the terminal transition contract", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [
            {
              type: "assistant",
              message: { role: "assistant", content: "hello" },
              session_id: "s-1",
              parent_tool_use_id: null,
            },
            createSuccessResultMessage(),
          ],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-mixed-terminal",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      expect(handleDaemonEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          deferTerminalTransitionToRoute: true,
        }),
      );
      expect(updateThreadChatWithTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "assistant.message_done",
        }),
      );
      expect(updateAgentRunContext).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({ status: "completed" }),
        }),
      );
    });

    it("routes stopped terminals through v3 + terminal status updates (no divergence)", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [
            {
              type: "custom-stop",
              duration_ms: 10,
            } as any,
          ],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-stopped",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      expect(v3BridgeMocks.appendEventAndAdvance).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowId: "wf-pure-v2",
          event: { type: "stop_requested" },
        }),
      );
      expect(updateThreadChatWithTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "assistant.message_stop",
        }),
      );
      expect(updateAgentRunContext).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({ status: "stopped" }),
        }),
      );
    });

    it("fails closed when terminal status CAS loses and thread_chat is still non-terminal", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );
      vi.mocked(updateThreadChatWithTransition).mockResolvedValue({
        didUpdateStatus: false,
        updatedStatus: "working-done",
        chatSequence: undefined,
      });
      vi.mocked(getThreadChat).mockResolvedValue({
        id: "chat-1",
        threadId: "thread-1",
        userId: "user-1",
        status: "working",
        messages: [],
        queuedMessages: [],
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
          eventId: "event-pure-v2-cas-lose",
          runId: "run-1",
          seq: 10,
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error).toBe("daemon_event_terminal_thread_chat_cas_failed");
      expect(updateAgentRunContext).not.toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({ status: "completed" }),
        }),
      );
    });

    it("treats terminal status CAS races as success when thread_chat is already terminal", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );
      vi.mocked(updateThreadChatWithTransition).mockResolvedValue({
        didUpdateStatus: false,
        updatedStatus: "working-done",
        chatSequence: undefined,
      });
      vi.mocked(getThreadChat).mockResolvedValue({
        id: "chat-1",
        threadId: "thread-1",
        userId: "user-1",
        status: "working-done",
        messages: [],
        queuedMessages: [],
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
          eventId: "event-pure-v2-cas-win",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      expect(updateAgentRunContext).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({ status: "completed" }),
        }),
      );
    });

    it("fails closed when mixed terminal batch CAS loses and thread_chat is still non-terminal", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );
      vi.mocked(updateThreadChatWithTransition).mockResolvedValue({
        didUpdateStatus: false,
        updatedStatus: "working-done",
        chatSequence: undefined,
      });
      vi.mocked(getThreadChat).mockResolvedValue({
        id: "chat-1",
        threadId: "thread-1",
        userId: "user-1",
        status: "working",
        messages: [],
        queuedMessages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [
            {
              type: "assistant",
              message: { role: "assistant", content: "hello" },
              session_id: "s-1",
              parent_tool_use_id: null,
            },
            createSuccessResultMessage(),
          ],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-mixed-cas-lose",
          runId: "run-1",
          seq: 10,
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error).toBe("daemon_event_terminal_thread_chat_cas_failed");
      expect(updateAgentRunContext).not.toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({ status: "completed" }),
        }),
      );
    });

    it("routes canonical-only run-terminal payloads through the fenced terminal transition", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );
      vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
        runId: "run-1",
        workflowId: "wf-pure-v2",
        runSeq: 7,
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
        status: "processing",
        tokenNonce: "nonce-1",
        daemonTokenKeyId: "api-key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);
      v3BridgeMocks.getWorkflowHead.mockResolvedValue({
        state: "implementing",
        activeRunId: "run-1",
        activeRunSeq: 7,
      });

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [],
          canonicalEvents: [
            createCanonicalRunStartedEvent(),
            createCanonicalRunTerminalEvent({ status: "completed" }),
          ],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-canonical-only-terminal",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      expect(handleDaemonEvent).not.toHaveBeenCalled();
      expect(updateThreadChatWithTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "assistant.message_done",
        }),
      );
      expect(v3BridgeMocks.appendEventAndAdvance).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowId: "wf-pure-v2",
          event: expect.objectContaining({
            type: "run_completed",
            runId: "run-1",
            runSeq: 7,
          }),
        }),
      );
      expect(updateAgentRunContext).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({ status: "completed" }),
        }),
      );
    });

    it("persists canonical events before legacy handling", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          canonicalEvents: [createCanonicalRunStartedEvent()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-canonical",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      expect(persistAndPublishAgUiEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          threadId: "thread-1",
          threadChatId: "chat-1",
        }),
      );
      expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
      expect(
        agUiPublisherMocks.persistAndPublishAgUiEvents.mock
          .invocationCallOrder[0] ?? 0,
      ).toBeLessThan(
        vi.mocked(handleDaemonEvent).mock.invocationCallOrder[0] ?? Infinity,
      );
    });

    it("assigns the resulting thread chat replay sequence back onto canonical events", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );
      vi.mocked(handleDaemonEvent).mockResolvedValue({
        success: true,
        threadChatMessageSeq: 12,
      });

      // The route threads the publisher's `insertedEventIds` through to
      // `assignThreadChatMessageSeqToCanonicalEvents` directly — no double
      // mapper call. Mock the publisher's return value accordingly.
      const persistedEventIds = [
        "canonical-event-1:RUN_STARTED:0",
        "canonical-event-1:RUN_STARTED:1",
      ];
      agUiPublisherMocks.persistAndPublishAgUiEvents.mockResolvedValueOnce({
        inserted: persistedEventIds.length,
        skipped: 0,
        insertedEventIds: persistedEventIds,
      });

      const canonicalEvent = createCanonicalRunStartedEvent();
      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          canonicalEvents: [canonicalEvent],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-replay-seq",
          runId: "run-1",
          seq: 11,
        }),
      );

      expect(response.status).toBe(200);
      expect(assignThreadChatMessageSeqToCanonicalEvents).toHaveBeenCalledWith({
        db: dbMocks.db,
        eventIds: persistedEventIds,
        threadChatMessageSeq: 12,
      });
      expect(
        vi.mocked(handleDaemonEvent).mock.invocationCallOrder[0] ?? Infinity,
      ).toBeLessThan(
        vi.mocked(assignThreadChatMessageSeqToCanonicalEvents).mock
          .invocationCallOrder[0] ?? Infinity,
      );
    });

    it("passes the fetched runContext and fallback workflowId to handleDaemonEvent", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );
      vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
        runId: "run-1",
        workflowId: null,
        runSeq: null,
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
        status: "processing",
        tokenNonce: "nonce-1",
        daemonTokenKeyId: "api-key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-context",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      expect(handleDaemonEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          runContext: expect.objectContaining({
            runId: "run-1",
            workflowId: null,
          }),
          workflowId: "wf-pure-v2",
        }),
      );
    });

    it("rejects canonical event context mismatches before legacy handling", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          canonicalEvents: [
            createCanonicalRunStartedEvent({ threadChatId: "chat-other" }),
          ],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-canonical-mismatch",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        success: false,
        error: "daemon_event_canonical_event_context_mismatch",
        eventId: "canonical-event-1",
        reason: "threadChatId",
      });
      expect(persistAndPublishAgUiEvents).not.toHaveBeenCalled();
      expect(handleDaemonEvent).not.toHaveBeenCalled();
    });

    it("skips v1 signal inbox for enrolled workflows", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-2",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      // v1 signal inbox claim was NOT called (no insert into sdlcLoopSignalInbox)
      expect(dbMocks.signalInboxFindFirst).not.toHaveBeenCalled();
    });

    it("acknowledges canonical-only event batches without legacy handling", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );
      vi.mocked(getThreadMinimal).mockResolvedValue({
        id: "thread-1",
        userId: "user-1",
        codesandboxId: "sandbox-2",
        sandboxProvider: "docker",
      } as unknown as Awaited<ReturnType<typeof getThreadMinimal>>);
      agUiPublisherMocks.persistAndPublishAgUiEvents.mockResolvedValueOnce({
        inserted: 1,
        skipped: 0,
        insertedEventIds: ["canonical-event-1:RUN_STARTED:0"],
      });

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [],
          canonicalEvents: [createCanonicalRunStartedEvent()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-canonical-only",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        canonicalEventsPersisted: 1,
        canonicalEventsDeduplicated: 0,
      });
      expect(persistAndPublishAgUiEvents).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(touchThreadChatUpdatedAt).toHaveBeenCalledWith({
          db: dbMocks.db,
          threadId: "thread-1",
          threadChatId: "chat-1",
        });
      });
      await vi.waitFor(() => {
        expect(extendSandboxLife).toHaveBeenCalledWith({
          sandboxId: "sandbox-2",
          sandboxProvider: "docker",
        });
      });
      expect(handleDaemonEvent).not.toHaveBeenCalled();
    });

    it("reports deduplicated canonical-only batches without overcounting inserts", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );
      agUiPublisherMocks.persistAndPublishAgUiEvents.mockResolvedValueOnce({
        inserted: 0,
        skipped: 1,
        insertedEventIds: [],
      });

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [],
          canonicalEvents: [createCanonicalRunStartedEvent()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-canonical-only-dup",
          runId: "run-1",
          seq: 11,
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        canonicalEventsPersisted: 0,
        canonicalEventsDeduplicated: 1,
      });
      expect(handleDaemonEvent).not.toHaveBeenCalled();
    });

    it("keeps canonical-only acknowledgements successful when freshness work fails", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );
      agUiPublisherMocks.persistAndPublishAgUiEvents.mockResolvedValueOnce({
        inserted: 1,
        skipped: 0,
        insertedEventIds: ["canonical-event-1:RUN_STARTED:0"],
      });
      vi.mocked(touchThreadChatUpdatedAt).mockRejectedValue(
        new Error("touch failed"),
      );

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [],
          canonicalEvents: [createCanonicalRunStartedEvent()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-canonical-only-touch-fail",
          runId: "run-1",
          seq: 12,
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        canonicalEventsPersisted: 1,
        canonicalEventsDeduplicated: 0,
      });
      await vi.waitFor(() => {
        expect(touchThreadChatUpdatedAt).toHaveBeenCalledWith({
          db: dbMocks.db,
          threadId: "thread-1",
          threadChatId: "chat-1",
        });
      });
      expect(handleDaemonEvent).not.toHaveBeenCalled();
    });

    it("fails closed when canonical persistence fails", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );
      agUiPublisherMocks.persistAndPublishAgUiEvents.mockRejectedValueOnce(
        new Error("Sequence collision"),
      );

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          canonicalEvents: [createCanonicalRunStartedEvent()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-canonical-fail",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        success: false,
        error: "daemon_event_canonical_event_persist_failed",
        code: "database_error",
      });
      expect(handleDaemonEvent).not.toHaveBeenCalled();
    });

    it("processes ACK for pending dispatch intent", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
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
        status: "pending",
        tokenNonce: "nonce-1",
        daemonTokenKeyId: "api-key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);

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
          payloadVersion: 2,
          eventId: "event-pure-v2-ack",
          runId: "run-1",
          seq: 0,
        }),
      );

      expect(response.status).toBe(200);
      // ACK lifecycle was triggered (handleAckReceived is mocked at module level)
      const { handleAckReceived } = await import(
        "@/server-lib/delivery-loop/ack-lifecycle"
      );
      expect(handleAckReceived).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          loopId: "wf-pure-v2",
          threadChatId: "chat-1",
        }),
      );
    });

    it("handles processing event claims via Redis", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );
      // Redis claim succeeds
      redisMocks.get.mockResolvedValue(null);
      redisMocks.set.mockResolvedValue("OK");

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [
            {
              type: "assistant",
              message: {
                id: "msg-1",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "working..." }],
                model: "claude-sonnet-4-20250514",
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 5 },
              },
              session_id: "session-1",
            },
          ],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-processing",
          runId: "run-1",
          seq: 1,
        }),
      );

      expect(response.status).toBe(200);
      // Redis was used for the processing event claim (not DB signal inbox)
      expect(redisMocks.set).toHaveBeenCalled();
    });

    it("persists terminal dispatch status on completion", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-terminal",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      // persistDaemonTerminalDispatchStatus calls updateDispatchIntent and markDispatchIntentCompleted
      expect(dispatchIntentMocks.updateDispatchIntent).toHaveBeenCalledWith(
        expect.stringContaining("wf-pure-v2"),
        "chat-1",
        expect.objectContaining({ status: "completed" }),
      );
      expect(markDispatchIntentCompleted).toHaveBeenCalled();
    });

    it("allows terminal daemon-event via test auth and publishes delivery-loop refetch broadcast", async () => {
      vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue(null);
      vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
        runId: "run-1",
        workflowId: "wf-pure-v2",
        runSeq: 2,
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
        status: "processing",
        tokenNonce: "nonce-1",
        daemonTokenKeyId: "api-key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );

      const response = await POST(
        createDaemonRequest(
          {
            threadId: "thread-1",
            threadChatId: "chat-1",
            messages: [createSuccessResultMessage()],
            timezone: "UTC",
            payloadVersion: 2,
            eventId: "event-test-auth-terminal-broadcast",
            runId: "run-1",
            seq: 10,
          },
          {
            "X-Terragon-Test-Daemon-Auth": "enabled",
            "X-Terragon-Test-User-Id": "user-1",
            "X-Terragon-Secret": env.INTERNAL_SHARED_SECRET,
          },
        ),
      );

      expect(response.status).toBe(200);
      expect(publishBroadcastUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "user-1",
          type: "user",
          data: expect.objectContaining({
            threadPatches: expect.arrayContaining([
              expect.objectContaining({
                threadId: "thread-1",
                threadChatId: "chat-1",
                op: "refetch",
                refetch: ["delivery-loop"],
              }),
            ]),
          }),
        }),
      );
    });

    it("fences planning terminal completions with persisted runSeq", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );
      vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
        runId: "run-1",
        workflowId: "wf-pure-v2",
        runSeq: 4,
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
        status: "processing",
        tokenNonce: "nonce-1",
        daemonTokenKeyId: "api-key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);
      v3BridgeMocks.getWorkflowHead.mockResolvedValue({
        state: "planning",
      });

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-planning-terminal",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      expect(v3BridgeMocks.appendEventAndAdvance).toHaveBeenCalledTimes(1);
      expect(v3BridgeMocks.appendEventAndAdvance).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          workflowId: "wf-pure-v2",
          event: {
            type: "planning_run_completed",
            runId: "run-1",
            runSeq: 4,
          },
        }),
      );
    });

    it("falls back to legacy planning terminal completion when runSeq is missing to avoid planning deadlock", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );
      vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
        runId: "run-1",
        workflowId: "wf-pure-v2",
        runSeq: null,
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
        status: "processing",
        tokenNonce: "nonce-1",
        daemonTokenKeyId: "api-key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);
      v3BridgeMocks.getWorkflowHead.mockResolvedValue({
        state: "planning",
      });

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-planning-terminal-legacy",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      expect(v3BridgeMocks.appendEventAndAdvance).toHaveBeenCalledTimes(1);
      expect(v3BridgeMocks.appendEventAndAdvance).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          workflowId: "wf-pure-v2",
          event: { type: "planning_run_completed" },
        }),
      );
    });

    it("uses the active workflow head runSeq for implementing terminals when legacy runContext rows are missing it", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );
      vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
        runId: "run-1",
        workflowId: "wf-pure-v2",
        runSeq: null,
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
        status: "processing",
        tokenNonce: "nonce-1",
        daemonTokenKeyId: "api-key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);
      v3BridgeMocks.getWorkflowHead.mockResolvedValue({
        state: "implementing",
        activeRunId: "run-1",
        activeRunSeq: 7,
      });

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-implementing-terminal",
          runId: "run-1",
          seq: 10,
          headShaAtCompletion: "sha-complete",
        }),
      );

      expect(response.status).toBe(200);
      expect(v3BridgeMocks.appendEventAndAdvance).toHaveBeenCalledTimes(1);
      expect(v3BridgeMocks.appendEventAndAdvance).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowId: "wf-pure-v2",
          event: expect.objectContaining({
            type: "run_completed",
            runId: "run-1",
            runSeq: 7,
            headSha: "sha-complete",
          }),
        }),
      );
    });

    it("rejects pure v2 daemon event without v2 envelope", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue(
        PURE_V2_WORKFLOW as Awaited<
          ReturnType<typeof getActiveWorkflowForThread>
        >,
      );

      const response = await POST(
        createDaemonRequest(
          {
            threadId: "thread-1",
            threadChatId: "chat-1",
            messages: [createSuccessResultMessage()],
            timezone: "UTC",
          },
          {},
          { autoCapabilities: false },
        ),
      );
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error).toBe("enrolled_loop_requires_v2_envelope");
      expect(handleDaemonEvent).not.toHaveBeenCalled();
    });

    // v1 bridged workflow test removed — sdlcLoop table no longer exists

    // VAL-CROSS-002: Duplicate ingress across API and runtime remains idempotent
    it("ensures duplicate daemon ingress does not cause duplicate logical transitions (VAL-CROSS-002)", async () => {
      vi.mocked(getActiveWorkflowForThread).mockResolvedValue({
        id: "wf-dedup-test",
        threadId: "thread-1",
        kind: "implementing",
        generation: 1,
      } as Awaited<ReturnType<typeof getActiveWorkflowForThread>>);
      // Align auth claims with envelope runId to avoid claim mismatch
      vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue({
        userId: "user-1",
        keyId: "api-key-1",
        claims: {
          kind: "daemon-run",
          runId: "run-dedup-1",
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
        runId: "run-dedup-1",
        workflowId: "wf-dedup-test",
        runSeq: 3,
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
        status: "processing",
        tokenNonce: "nonce-1",
        daemonTokenKeyId: "api-key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);
      v3BridgeMocks.getWorkflowHead.mockResolvedValue({
        state: "implementing",
        activeRunId: "run-dedup-1",
        activeRunSeq: 3,
      });

      // Simulate successful v3 bridge call
      let v3BridgeCallCount = 0;
      v3BridgeMocks.appendEventAndAdvance.mockImplementation(async () => {
        v3BridgeCallCount++;
        return {
          inserted: v3BridgeCallCount === 1, // First call inserts, second call is deduplicated
          transitioned: v3BridgeCallCount === 1,
          effectsInserted: v3BridgeCallCount === 1 ? 2 : 0,
          stateBefore: "implementing",
          stateAfter:
            v3BridgeCallCount === 1 ? "gating_review" : "implementing",
        };
      });

      // First ingress - should process normally
      const firstResponse = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-dedup-1",
          runId: "run-dedup-1",
          seq: 5,
          headShaAtCompletion: "sha-dedup",
        }),
      );

      expect(firstResponse.status).toBe(200);
      const firstData = await firstResponse.json();
      expect(firstData.success).toBe(true);

      // After first request, run context becomes terminal
      vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
        runId: "run-dedup-1",
        workflowId: "wf-dedup-test",
        runSeq: 3,
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
        status: "completed", // Now terminal
        tokenNonce: "nonce-1",
        daemonTokenKeyId: "api-key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);

      // Simulate Redis committed key now present (event was processed)
      redisMocks.get.mockResolvedValueOnce(new Date().toISOString());

      // Second ingress (duplicate) - should be deduplicated
      const secondResponse = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-dedup-1", // Same eventId as first
          runId: "run-dedup-1",
          seq: 5,
          headShaAtCompletion: "sha-dedup",
        }),
      );

      expect(secondResponse.status).toBe(202);
      const secondData = await secondResponse.json();
      // After first request, run context is terminal so route returns run_terminal_ignored
      // before hitting claim/dedup logic (both are valid dedup paths for VAL-CROSS-002)
      expect(secondData.reason).toBe("run_terminal_ignored");
      expect(secondData.deduplicated).toBe(true);

      // Third ingress (replay with different seq but same event) - should also be deduplicated
      redisMocks.get.mockResolvedValueOnce(new Date().toISOString());

      const thirdResponse = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-dedup-1",
          runId: "run-dedup-1",
          seq: 999, // Different seq, but same eventId so still duplicate
          headShaAtCompletion: "sha-dedup",
        }),
      );

      expect(thirdResponse.status).toBe(202);
      const thirdData = await thirdResponse.json();
      expect(thirdData.reason).toBe("run_terminal_ignored");
      expect(thirdData.deduplicated).toBe(true);

      // handlerDaemonEvent should only be called once (first request)
      expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
    });
  });
});
