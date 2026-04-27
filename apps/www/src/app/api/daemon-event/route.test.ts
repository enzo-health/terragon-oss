import {
  DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
  DAEMON_EVENT_CAPABILITIES_HEADER,
} from "@terragon/daemon/shared";
import { env } from "@terragon/env/apps-www";
import { extendSandboxLife } from "@terragon/sandbox";
import { publishBroadcastUserMessage } from "@terragon/shared/broadcast-server";
import { assignThreadChatMessageSeqToCanonicalEvents } from "@terragon/shared/model/agent-event-log";
import {
  completeAgentRunContextTerminal,
  getAgentRunContextByRunId,
  updateAgentRunContext,
} from "@terragon/shared/model/agent-run-context";
import {
  getThreadChat,
  getThreadMinimal,
  touchThreadChatUpdatedAt,
  updateThreadChatTerminalMetadataIfTerminal,
} from "@terragon/shared/model/threads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { getDaemonTokenAuthContextOrNull } from "@/lib/auth-server";
import { persistAndPublishAgUiEvents } from "@/server-lib/ag-ui-publisher";
import { getDaemonEventDbPreflight } from "@/server-lib/daemon-event-db-preflight";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import { maybeProcessFollowUpQueue } from "@/server-lib/process-follow-up-queue";
import { POST } from "./route";

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

const canonicalEventLogMocks = vi.hoisted(() => ({
  assignThreadChatMessageSeqToCanonicalEvents: vi.fn(),
  findOpenAgUiMessagesForRun: vi.fn(),
}));

const agUiPublisherMocks = vi.hoisted(() => ({
  persistAgUiEvents: vi.fn(),
  persistAndPublishAgUiEvents: vi.fn(),
  publishPersistedAgUiEvents: vi.fn(),
  broadcastAgUiEventEphemeral: vi.fn(),
  canonicalEventsToAgUiRows: vi.fn(
    (events: Array<{ eventId: string; type?: string }>) =>
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

const sandboxResourceMocks = vi.hoisted(() => ({
  hasOtherActiveRuns: vi.fn(),
  setActiveThreadChat: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({
  getDaemonTokenAuthContextOrNull: vi.fn(),
  hasDaemonProviderScope: vi.fn(
    (claims: { providers: string[] }, provider: string) =>
      claims.providers.includes(provider),
  ),
}));

vi.mock("@/agent/sandbox-resource", () => sandboxResourceMocks);

vi.mock("@/server-lib/handle-daemon-event", () => ({
  handleDaemonEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: dbMocks.db,
}));

vi.mock("@/server-lib/process-follow-up-queue", () => ({
  maybeProcessFollowUpQueue: vi.fn(),
}));

vi.mock("@/server-lib/follow-up", () => ({
  queueFollowUpInternal: vi.fn(),
}));

vi.mock("@terragon/shared/model/agent-run-context", () => ({
  completeAgentRunContextTerminal: vi.fn(),
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

vi.mock("@terragon/shared/model/agent-event-log", () => ({
  assignThreadChatMessageSeqToCanonicalEvents:
    canonicalEventLogMocks.assignThreadChatMessageSeqToCanonicalEvents,
  findOpenAgUiMessagesForRun: canonicalEventLogMocks.findOpenAgUiMessagesForRun,
}));

vi.mock("@/server-lib/ag-ui-publisher", () => agUiPublisherMocks);

vi.mock("@terragon/shared/broadcast-server", () => ({
  publishBroadcastUserMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server-lib/daemon-event-db-preflight", () => ({
  getDaemonEventDbPreflight: vi.fn(),
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
    vi.mocked(completeAgentRunContextTerminal).mockImplementation(
      async (params: Parameters<typeof completeAgentRunContextTerminal>[0]) => {
        const existing = await getAgentRunContextByRunId({
          db: params.db,
          userId: params.userId,
          runId: params.runId,
        });
        if (!existing) {
          return {
            status: "rejected",
            reason: "run_context_not_found",
            runContext: null,
          };
        }
        if (
          (existing.status === "completed" ||
            existing.status === "failed" ||
            existing.status === "stopped") &&
          existing.terminalEventId === params.terminalEventId
        ) {
          return {
            status: "duplicate",
            runContext: existing,
          };
        }
        if (
          existing.status === "completed" ||
          existing.status === "failed" ||
          existing.status === "stopped"
        ) {
          return {
            status: "rejected",
            reason: "already_terminal_different_event",
            runContext: existing,
          };
        }
        await updateAgentRunContext({
          db: params.db,
          userId: params.userId,
          runId: params.runId,
          updates: {
            status: params.terminalStatus,
            lastAcceptedSeq: params.lastAcceptedSeq,
            terminalEventId: params.terminalEventId,
            ...params.failureUpdates,
          },
        });
        return {
          status: "committed",
          runContext: {
            ...existing,
            status: params.terminalStatus,
            lastAcceptedSeq: params.lastAcceptedSeq,
            terminalEventId: params.terminalEventId,
            ...params.failureUpdates,
            updatedAt: new Date(),
          } as NonNullable<
            Awaited<ReturnType<typeof getAgentRunContextByRunId>>
          >,
        };
      },
    );
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
    vi.mocked(handleDaemonEvent).mockResolvedValue({
      success: true,
      threadChatMessageSeq: null,
      terminalRecoveryQueued: false,
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
    sandboxResourceMocks.hasOtherActiveRuns.mockResolvedValue(false);
    sandboxResourceMocks.setActiveThreadChat.mockResolvedValue(undefined);
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
    agUiPublisherMocks.persistAgUiEvents.mockResolvedValue({
      inserted: 0,
      skipped: 0,
      insertedEventIds: [],
      persistedEvents: [],
    });
    agUiPublisherMocks.publishPersistedAgUiEvents.mockResolvedValue(undefined);
    agUiPublisherMocks.broadcastAgUiEventEphemeral.mockResolvedValue(undefined);
    canonicalEventLogMocks.findOpenAgUiMessagesForRun.mockResolvedValue([]);
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
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "daemon_auth_context_missing",
    });
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

  it("does not publish meta events before full daemon-token validation", async () => {
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
        issuedAt: Date.now() - 120_000,
        exp: Date.now() - 60_000,
      },
    });
    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [],
        metaEvents: [{ type: "thread-token-usage-updated", inputTokens: 1 }],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-expired-meta",
        runId: "run-1",
        seq: 0,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe("daemon_token_expired");
    expect(getDaemonEventDbPreflight).not.toHaveBeenCalled();
    expect(getAgentRunContextByRunId).not.toHaveBeenCalled();
    expect(agUiPublisherMocks.metaEventsToAgUiEvents).not.toHaveBeenCalled();
    expect(
      agUiPublisherMocks.broadcastAgUiEventEphemeral,
    ).not.toHaveBeenCalled();
    expect(
      agUiPublisherMocks.persistAndPublishAgUiEvents,
    ).not.toHaveBeenCalled();
    expect(agUiPublisherMocks.persistAgUiEvents).not.toHaveBeenCalled();
  });

  it("fails terminal requests before CAS when canonical persistence is unavailable", async () => {
    vi.mocked(getDaemonEventDbPreflight).mockResolvedValueOnce({
      agentEventLogReady: false,
      agentRunContextFailureColumnsReady: true,
      missing: ["agent_event_log"],
    });

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-terminal-without-log",
        runId: "run-1",
        seq: 10,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(503);
    expect(data).toEqual({
      success: false,
      error: "daemon_event_canonical_persistence_unavailable",
      missing: ["agent_event_log"],
    });
    expect(completeAgentRunContextTerminal).not.toHaveBeenCalled();
    expect(agUiPublisherMocks.persistAgUiEvents).not.toHaveBeenCalled();
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("fails closed when runtime-session run-context columns are unavailable", async () => {
    vi.mocked(getDaemonEventDbPreflight).mockResolvedValueOnce({
      agentEventLogReady: true,
      agentRunContextFailureColumnsReady: false,
      missing: [
        "agent_run_context.runtime_provider",
        "agent_run_context.previous_response_id",
      ],
    });

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-schema-not-ready",
        runId: "run-1",
        seq: 0,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(503);
    expect(data).toEqual({
      success: false,
      error: "daemon_event_runtime_session_schema_not_ready",
      missing: [
        "agent_run_context.runtime_provider",
        "agent_run_context.previous_response_id",
      ],
    });
    expect(getAgentRunContextByRunId).not.toHaveBeenCalled();
    expect(handleDaemonEvent).not.toHaveBeenCalled();
    expect(agUiPublisherMocks.persistAgUiEvents).not.toHaveBeenCalled();
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

  it("drops canonical assistant-message replay rows when deltas are present", async () => {
    const timestamp = new Date().toISOString();
    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        payloadVersion: 2,
        eventId: "event-filter-1",
        runId: "run-1",
        seq: 9,
        messages: [],
        canonicalEvents: [
          {
            payloadVersion: 2,
            eventId: "canon-run-started",
            runId: "run-1",
            threadId: "thread-1",
            threadChatId: "chat-1",
            seq: 0,
            timestamp,
            category: "operational",
            type: "run-started",
            agent: "codex",
            transportMode: "legacy",
            protocolVersion: 2,
          },
          {
            payloadVersion: 2,
            eventId: "canon-assistant",
            runId: "run-1",
            threadId: "thread-1",
            threadChatId: "chat-1",
            seq: 1,
            timestamp,
            category: "transcript",
            type: "assistant-message",
            messageId: "m-canon",
            content: "duplicate me",
          },
        ],
        deltas: [
          {
            messageId: "msg_delta",
            partIndex: 0,
            deltaSeq: 0,
            kind: "text",
            text: "duplicate me",
          },
        ],
        timezone: "UTC",
      }),
    );

    expect(response.status).toBe(200);
    const canonicalEventsArg =
      agUiPublisherMocks.canonicalEventsToAgUiRows.mock.calls.at(
        -1,
      )?.[0] as Array<{ type: string }>;
    expect(canonicalEventsArg).toEqual([
      expect.objectContaining({ type: "run-started" }),
    ]);
    expect(
      canonicalEventsArg.some((event) => event.type === "assistant-message"),
    ).toBe(false);
  });

  it("rejects filtered canonical assistant context mismatches before persistence", async () => {
    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        payloadVersion: 2,
        eventId: "event-filter-context-mismatch",
        runId: "run-1",
        seq: 9,
        messages: [],
        canonicalEvents: [
          {
            payloadVersion: 2,
            eventId: "canon-assistant-mismatch",
            runId: "run-1",
            threadId: "thread-other",
            threadChatId: "chat-1",
            seq: 1,
            timestamp: new Date().toISOString(),
            category: "transcript",
            type: "assistant-message",
            messageId: "m-canon",
            content: "duplicate me",
          },
        ],
        deltas: [
          {
            messageId: "msg_delta",
            partIndex: 0,
            deltaSeq: 0,
            kind: "text",
            text: "duplicate me",
          },
        ],
        timezone: "UTC",
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data).toMatchObject({
      success: false,
      error: "daemon_event_canonical_event_context_mismatch",
      eventId: "canon-assistant-mismatch",
      reason: "threadId",
    });
    expect(
      agUiPublisherMocks.persistAndPublishAgUiEvents,
    ).not.toHaveBeenCalled();
    expect(agUiPublisherMocks.persistAgUiEvents).not.toHaveBeenCalled();
    expect(handleDaemonEvent).not.toHaveBeenCalled();
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

  it("rejects canonical daemon events without v2 envelope when daemon advertises v2 capability", async () => {
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

  it("rejects canonical daemon events with malformed v2 envelope when daemon advertises v2 capability", async () => {
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

  it("rejects non-v2 terminal messages before legacy terminal side effects", async () => {
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
    expect(data.error).toBe("daemon_event_terminal_requires_v2_envelope");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
    expect(updateThreadChatWithTransition).not.toHaveBeenCalled();
    expect(completeAgentRunContextTerminal).not.toHaveBeenCalled();
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
      terminalEventId: "event-terminal",
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
      terminalEventId: "event-terminal",
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
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("returns protocol ack shape for run_terminal_ignored responses", async () => {
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
      terminalEventId: "event-terminal",
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

  it("rejects daemon-token provider scope mismatch before terminal side effects", async () => {
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
        providers: ["openai"],
        nonce: "nonce-1",
        issuedAt: Date.now(),
        exp: Date.now() + 60_000,
      },
    });

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [createSuccessResultMessage()],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-provider-mismatch",
        runId: "run-1",
        seq: 10,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe("daemon_token_provider_scope_mismatch");
    expect(completeAgentRunContextTerminal).not.toHaveBeenCalled();
    expect(agUiPublisherMocks.persistAgUiEvents).not.toHaveBeenCalled();
    expect(
      agUiPublisherMocks.persistAndPublishAgUiEvents,
    ).not.toHaveBeenCalled();
    expect(
      agUiPublisherMocks.broadcastAgUiEventEphemeral,
    ).not.toHaveBeenCalled();
    expect(updateThreadChatWithTransition).not.toHaveBeenCalled();
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

  // VAL-API-014: Pure-v2 terminal events are terminal in the canonical runtime only.
  it("handles pure-v2 terminal daemon events without canonical runtime writes", async () => {
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
        eventId: "event-terminal-v3",
        runId: "run-1",
        seq: 10,
        headShaAtCompletion: "sha-123",
      }),
    );

    expect(response.status).toBe(200);
    expect(updateThreadChatWithTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        threadChatId: "chat-1",
        eventType: "assistant.message_done",
        skipBroadcast: true,
      }),
    );
    expect(updateAgentRunContext).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        userId: "user-1",
        updates: expect.objectContaining({
          status: "completed",
          terminalEventId: "event-terminal-v3",
        }),
      }),
    );
  });

  it("deduplicates replay of pure-v2 terminal daemon event without duplicate v3 side effects", async () => {
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
      status: "completed", // Terminal status
      terminalEventId: "event-terminal-dup",
      tokenNonce: "nonce-1",
      daemonTokenKeyId: "api-key-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);

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
    await expect(firstResponse.json()).resolves.toMatchObject({
      reason: "run_terminal_ignored",
      deduplicated: true,
    });
    // Duplicate terminal acknowledgements still run transcript projection, but
    // skip legacy terminal side effects.

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
  });

  // Removed: "re-enqueues daemon-terminal feedback" — v1 follow-up re-enqueue
  // logic was removed; v2 handles dispatch via work items.

  it("does not replay self-dispatch on duplicate terminal acknowledgements", async () => {
    // In v2, duplicate terminal acks are handled via run_terminal_ignored
    // (runContext.status === "completed" → 202 before dedup/claim).
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
      terminalEventId: "event-dup-terminal",
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
  });

  it("returns protocol ack shape for out-of-order terminal acknowledgements", async () => {
    // In v2, out-of-order terminal acks are handled via run_terminal_ignored
    // (runContext.status === "completed" → 202 before any seq check).
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
      terminalEventId: "event-out-of-order",
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
    expect(updateAgentRunContext).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        userId: "user-1",
        updates: expect.objectContaining({
          previousResponseId: "resp-next-999",
        }),
      }),
    );
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

  it("does not fail canonical event handling when codexPreviousResponseId persistence fails", async () => {
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

  it("rejects canonical daemon events without v2 envelope even when capability header is missing", async () => {
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
    expect(data.error).toBe("daemon_event_terminal_requires_v2_envelope");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("requires v2 envelopes for canonical terminal runs even without capability headers", async () => {
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
    expect(data.error).toBe("daemon_event_terminal_requires_v2_envelope");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
    expect(dbMocks.insert).not.toHaveBeenCalled();
  });

  it("accepts canonical daemon events with v2 envelope", async () => {
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

      expect(secondResponse.status).toBe(200);
      expect(await secondResponse.json()).toMatchObject({ success: true });

      expect(handleDaemonEvent).toHaveBeenCalledTimes(2);
    });

    it("does not use runtime claim conflicts to block duplicate processing", async () => {
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
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true });
      expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
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

  it("does not hold runtime claims when daemon handling fails so retries can process the message", async () => {
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
        terminalRecoveryQueued: false,
      });

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

  it("routes repeated daemon envelopes through canonical handlers without Redis claim dedupe", async () => {
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

    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      success: true,
      acknowledgedEventId: "event-duplicate",
      acknowledgedSeq: 2,
    });
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
  });

  it("ignores stale runtime claim conflicts for daemon events", async () => {
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

    expect(response.status).toBe(200);
    expect(data).toMatchObject({ success: true });
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
  });

  it("reclaims stale unprocessed daemon-event claims so the event is replayed", async () => {
    // No committed key → claim succeeds → event is processed normally

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

  it("does not consult stale committed runtime claims before replaying daemon events", async () => {
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

    expect(response.status).toBe(200);
    expect(data).toMatchObject({ success: true });
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
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

  it("routes out-of-order daemon envelopes through canonical handlers", async () => {
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

    expect(response.status).toBe(200);
    expect(data).toMatchObject({ success: true });
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
  });

  it("does not let old runtime claim races block daemon envelopes", async () => {
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

    expect(response.status).toBe(200);
    expect(data).toMatchObject({ success: true });
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
  });

  describe("pure v2 workflow", () => {
    it("accepts pure v2 terminal events without runtime side effects", async () => {
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
      expect(sandboxResourceMocks.setActiveThreadChat).toHaveBeenCalledWith({
        sandboxId: "sandbox-1",
        threadChatId: "chat-1",
        isActive: false,
        runId: "run-1",
      });
    });

    it("fences mixed terminal batches (assistant + result) through the terminal transition contract", async () => {
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
          markAsUnread: true,
        }),
      );
      expect(updateAgentRunContext).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({ status: "completed" }),
        }),
      );
    });

    it("routes stopped terminals through canonical terminal status updates without v3 writes", async () => {
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
      expect(updateThreadChatWithTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "assistant.message_stop",
          markAsUnread: true,
        }),
      );
      expect(updateAgentRunContext).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({ status: "stopped" }),
        }),
      );
    });

    it("fails closed when terminal status CAS loses and thread_chat is still non-terminal", async () => {
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
      expect(completeAgentRunContextTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          terminalStatus: "completed",
          terminalEventId: "event-pure-v2-cas-lose",
        }),
      );
      expect(
        agUiPublisherMocks.broadcastAgUiEventEphemeral,
      ).not.toHaveBeenCalled();
    });

    it("treats terminal status CAS races as success when thread_chat is already terminal", async () => {
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
      expect(completeAgentRunContextTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          terminalStatus: "completed",
          terminalEventId: "event-pure-v2-mixed-cas-lose",
        }),
      );
      expect(
        agUiPublisherMocks.broadcastAgUiEventEphemeral,
      ).not.toHaveBeenCalled();
    });

    it("rejects stale canonical terminals before durable terminal append", async () => {
      vi.mocked(completeAgentRunContextTerminal).mockResolvedValueOnce({
        status: "rejected",
        reason: "stale_run",
        runContext: null,
      });

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [],
          canonicalEvents: [
            createCanonicalRunTerminalEvent({ status: "completed" }),
          ],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-stale-terminal",
          runId: "run-1",
          seq: 10,
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error).toBe("daemon_event_terminal_run_context_cas_failed");
      expect(data.reason).toBe("stale_run");
      expect(agUiPublisherMocks.persistAgUiEvents).not.toHaveBeenCalled();
      expect(
        agUiPublisherMocks.persistAndPublishAgUiEvents,
      ).not.toHaveBeenCalled();
      expect(updateThreadChatWithTransition).not.toHaveBeenCalled();
    });

    it("rejects canonical terminal context mismatches before run-context CAS", async () => {
      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [],
          canonicalEvents: [
            createCanonicalRunTerminalEvent({
              runId: "run-other",
              eventId: "canonical-terminal-mismatch",
              status: "completed",
            }),
          ],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-canonical-terminal-mismatch",
          runId: "run-1",
          seq: 10,
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data).toMatchObject({
        success: false,
        error: "daemon_event_canonical_event_context_mismatch",
        eventId: "canonical-terminal-mismatch",
        reason: "runId",
      });
      expect(completeAgentRunContextTerminal).not.toHaveBeenCalled();
      expect(agUiPublisherMocks.persistAgUiEvents).not.toHaveBeenCalled();
      expect(
        agUiPublisherMocks.persistAndPublishAgUiEvents,
      ).not.toHaveBeenCalled();
      expect(
        agUiPublisherMocks.broadcastAgUiEventEphemeral,
      ).not.toHaveBeenCalled();
      expect(updateThreadChatWithTransition).not.toHaveBeenCalled();
    });

    it("rejects different terminal events after a terminal event already won", async () => {
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
        terminalEventId: "event-winning-terminal",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);
      vi.mocked(completeAgentRunContextTerminal).mockResolvedValueOnce({
        status: "rejected",
        reason: "already_terminal_different_event",
        runContext: null,
      });

      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [createSuccessResultMessage()],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-different-terminal",
          runId: "run-1",
          seq: 11,
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.reason).toBe("already_terminal_different_event");
      expect(agUiPublisherMocks.persistAgUiEvents).not.toHaveBeenCalled();
      expect(handleDaemonEvent).not.toHaveBeenCalled();
    });

    it("retries mixed terminal projection after the same terminal event already won CAS", async () => {
      const terminalRunContext = {
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
        lastAcceptedSeq: 12,
        terminalEventId: "event-projection-retry",
        tokenNonce: "nonce-1",
        daemonTokenKeyId: "api-key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as NonNullable<Awaited<ReturnType<typeof getAgentRunContextByRunId>>>;
      const projectionError = new Error("projection failed after CAS");
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      vi.mocked(completeAgentRunContextTerminal)
        .mockResolvedValueOnce({
          status: "committed",
          runContext: terminalRunContext,
        })
        .mockResolvedValueOnce({
          status: "duplicate",
          runContext: terminalRunContext,
        });
      vi.mocked(handleDaemonEvent)
        .mockRejectedValueOnce(projectionError)
        .mockResolvedValueOnce({
          success: true,
          threadChatMessageSeq: null,
          terminalRecoveryQueued: false,
        });

      const requestBody = {
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [
          {
            type: "assistant",
            message: { role: "assistant", content: "final transcript" },
            session_id: "s-1",
            parent_tool_use_id: null,
          },
          createSuccessResultMessage(),
        ],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-projection-retry",
        runId: "run-1",
        seq: 12,
      };

      await expect(POST(createDaemonRequest(requestBody))).rejects.toThrow(
        projectionError,
      );
      expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
      expect(updateThreadChatWithTransition).not.toHaveBeenCalled();
      expect(updateAgentRunContext).not.toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({ status: "failed" }),
        }),
      );

      const retryResponse = await POST(createDaemonRequest(requestBody));
      const retryData = await retryResponse.json();

      expect(retryResponse.status).toBe(202);
      expect(retryData).toMatchObject({
        success: true,
        deduplicated: true,
        reason: "run_terminal_ignored",
        acknowledgedEventId: "event-projection-retry",
        acknowledgedSeq: 12,
      });
      expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
      consoleErrorSpy.mockRestore();
    });

    it("routes canonical-only run-terminal payloads through the fenced terminal transition", async () => {
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
          markAsUnread: true,
        }),
      );
      expect(updateAgentRunContext).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({ status: "completed" }),
        }),
      );
    });

    it("fences canonical-only terminals on non-enrolled runs (thread_chat still becomes terminal)", async () => {
      // No legacy workflow id on the run context.
      // @ts-ignore - Mock intentionally returns null for non-enrolled runs
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
          messages: [],
          canonicalEvents: [
            createCanonicalRunTerminalEvent({ status: "completed" }),
          ],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-canonical-only-terminal-non-enrolled",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      expect(handleDaemonEvent).not.toHaveBeenCalled();
      expect(updateThreadChatWithTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "assistant.message_done",
          markAsUnread: true,
        }),
      );
      expect(updateAgentRunContext).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({ status: "completed" }),
        }),
      );
    });

    it("preserves prompt-too-long classification in fenced terminal failures", async () => {
      const response = await POST(
        createDaemonRequest({
          threadId: "thread-1",
          threadChatId: "chat-1",
          messages: [
            {
              type: "custom-error",
              duration_ms: 10,
              error_info: "context length exceeded",
            } as any,
          ],
          timezone: "UTC",
          payloadVersion: 2,
          eventId: "event-pure-v2-fenced-prompt-too-long",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      expect(updateThreadChatTerminalMetadataIfTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            errorMessage: "prompt-too-long",
            errorMessageInfo: null,
          }),
        }),
      );
    });

    it("persists canonical events before legacy handling", async () => {
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
      expect(agUiPublisherMocks.persistAgUiEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          threadId: "thread-1",
          threadChatId: "chat-1",
        }),
      );
      expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
      expect(
        agUiPublisherMocks.persistAgUiEvents.mock.invocationCallOrder[0] ?? 0,
      ).toBeLessThan(
        vi.mocked(handleDaemonEvent).mock.invocationCallOrder[0] ?? Infinity,
      );
    });

    it("assigns the resulting thread chat replay sequence back onto canonical events", async () => {
      vi.mocked(handleDaemonEvent).mockResolvedValue({
        success: true,
        threadChatMessageSeq: 12,
        terminalRecoveryQueued: false,
      });

      // The route threads the publisher's `insertedEventIds` through to
      // `assignThreadChatMessageSeqToCanonicalEvents` directly — no double
      // mapper call. Mock the publisher's return value accordingly.
      const persistedEventIds = [
        "canonical-event-1:RUN_STARTED:0",
        "canonical-event-1:RUN_STARTED:1",
      ];
      agUiPublisherMocks.persistAgUiEvents.mockResolvedValueOnce({
        inserted: persistedEventIds.length,
        skipped: 0,
        insertedEventIds: persistedEventIds,
        persistedEvents: [],
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

    it("passes the fetched runContext to handleDaemonEvent", async () => {
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
          }),
        }),
      );
    });

    it("rejects canonical event context mismatches before legacy handling", async () => {
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

    it("skips v1 signal inbox for canonical runs", async () => {
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
      agUiPublisherMocks.persistAgUiEvents.mockRejectedValueOnce(
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

    it("does not process runtime ACK lifecycle for pending runs", async () => {
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
    });

    it("handles processing events without runtime Redis claims", async () => {
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
    });

    it("does not persist runtime dispatch status on completion", async () => {
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
    });

    it("allows terminal daemon-event via test auth without runtime refetch broadcast", async () => {
      vi.mocked(getDaemonTokenAuthContextOrNull).mockResolvedValue(null);
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
        status: "processing",
        tokenNonce: "nonce-1",
        daemonTokenKeyId: "api-key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);

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
      expect(publishBroadcastUserMessage).not.toHaveBeenCalled();
    });

    it("fences planning terminal completions without runtime journal writes", async () => {
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
          eventId: "event-pure-v2-planning-terminal",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      expect(updateThreadChatWithTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "assistant.message_done",
          markAsUnread: true,
        }),
      );
    });

    it("does not fall back to legacy planning journal writes when run sequence is missing", async () => {
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
          eventId: "event-pure-v2-planning-terminal-legacy",
          runId: "run-1",
          seq: 10,
        }),
      );

      expect(response.status).toBe(200);
      expect(updateThreadChatWithTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "assistant.message_done",
          markAsUnread: true,
        }),
      );
    });

    it("keeps implementing terminals canonical when legacy runContext rows are missing run sequence", async () => {
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
          eventId: "event-pure-v2-implementing-terminal",
          runId: "run-1",
          seq: 10,
          headShaAtCompletion: "sha-complete",
        }),
      );

      expect(response.status).toBe(200);
      expect(updateAgentRunContext).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          updates: expect.objectContaining({
            status: "completed",
            terminalEventId: "event-pure-v2-implementing-terminal",
          }),
        }),
      );
    });

    it("rejects pure v2 daemon event without v2 envelope", async () => {
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
      expect(data.error).toBe("daemon_event_terminal_requires_v2_envelope");
      expect(handleDaemonEvent).not.toHaveBeenCalled();
    });

    // v1 bridged workflow test removed — sdlcLoop table no longer exists

    // VAL-CROSS-002: Duplicate ingress across API and runtime remains idempotent
    it("ensures duplicate daemon ingress does not cause duplicate logical transitions (VAL-CROSS-002)", async () => {
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
        terminalEventId: "event-dedup-1",
        tokenNonce: "nonce-1",
        daemonTokenKeyId: "api-key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);

      // Simulate Redis committed key now present (event was processed)

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

      // Duplicate terminal acknowledgements stop at the run-context fence so
      // transcript projection and terminal metadata are not replayed.
      expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
    });
  });
});
