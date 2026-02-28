import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { getDaemonTokenAuthContextOrNull } from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import { getActiveSdlcLoopForThread } from "@terragon/shared/model/sdlc-loop";
import {
  getAgentRunContextByRunId,
  updateAgentRunContext,
} from "@terragon/shared/model/agent-run-context";
import { runBestEffortSdlcPublicationCoordinator } from "@/server-lib/sdlc-loop/publication";
import { runBestEffortSdlcSignalInboxTick } from "@/server-lib/sdlc-loop/signal-inbox";
import {
  DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
  DAEMON_EVENT_CAPABILITIES_HEADER,
} from "@terragon/daemon/shared";

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
      transaction,
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

vi.mock("@/lib/auth-server", () => ({
  getDaemonTokenAuthContextOrNull: vi.fn(),
}));

vi.mock("@/server-lib/handle-daemon-event", () => ({
  handleDaemonEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: dbMocks.db,
}));

vi.mock("@terragon/shared/model/sdlc-loop", () => ({
  getActiveSdlcLoopForThread: vi.fn(),
  SDLC_CAUSE_IDENTITY_VERSION: 1,
}));

vi.mock("@/server-lib/sdlc-loop/publication", () => ({
  runBestEffortSdlcPublicationCoordinator: vi.fn(),
}));

vi.mock("@/server-lib/sdlc-loop/signal-inbox", () => ({
  runBestEffortSdlcSignalInboxTick: vi.fn(),
}));

vi.mock("@terragon/shared/model/agent-run-context", () => ({
  getAgentRunContextByRunId: vi.fn(),
  updateAgentRunContext: vi.fn(),
}));

function createDaemonRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  options: { autoCapabilities?: boolean } = {},
) {
  const requestHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...headers,
  };

  const hasEnvelopeV2 =
    body.payloadVersion === 2 &&
    typeof body.eventId === "string" &&
    body.eventId.length > 0 &&
    typeof body.runId === "string" &&
    body.runId.length > 0 &&
    typeof body.seq === "number" &&
    Number.isInteger(body.seq) &&
    body.seq >= 0;
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
    body: JSON.stringify(body),
  });
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
        transportMode: "legacy",
        protocolVersion: 1,
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
    vi.mocked(updateAgentRunContext).mockResolvedValue(null);
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue(undefined);
    vi.mocked(handleDaemonEvent).mockResolvedValue({ success: true });
    vi.mocked(runBestEffortSdlcPublicationCoordinator).mockResolvedValue({
      executed: false,
      reason: "no_eligible_action",
    });
    vi.mocked(runBestEffortSdlcSignalInboxTick).mockResolvedValue({
      processed: false,
      reason: "no_unprocessed_signal",
    });
    dbMocks.execute.mockResolvedValue([]);
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
        messages: [],
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

  it("requires threadChatId for non-legacy daemon payloads", async () => {
    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        messages: [],
        timezone: "UTC",
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

  it("rejects enrolled-loop daemon events without v2 envelope even when capability header is missing", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [],
        timezone: "UTC",
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.error).toBe("enrolled_loop_requires_v2_envelope");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
    expect(runBestEffortSdlcSignalInboxTick).not.toHaveBeenCalled();
    expect(runBestEffortSdlcPublicationCoordinator).not.toHaveBeenCalled();
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
        messages: [],
        timezone: "UTC",
      }),
    );

    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.error).toBe("enrolled_loop_requires_v2_envelope");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
    expect(dbMocks.insert).not.toHaveBeenCalled();
    expect(runBestEffortSdlcSignalInboxTick).not.toHaveBeenCalled();
    expect(runBestEffortSdlcPublicationCoordinator).not.toHaveBeenCalled();
  });

  it("accepts enrolled-loop daemon events with v2 envelope", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      state: "enrolled",
      loopVersion: 11,
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [],
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
    expect(runBestEffortSdlcSignalInboxTick).toHaveBeenCalledWith({
      db: expect.any(Object),
      loopId: "loop-1",
      leaseOwnerToken: "daemon-event:event-1:1",
      guardrailRuntime: {
        killSwitchEnabled: false,
        cooldownUntil: null,
        maxIterations: null,
        manualIntentAllowed: true,
        iterationCount: 11,
      },
    });
    expect(runBestEffortSdlcPublicationCoordinator).toHaveBeenCalledWith({
      db: expect.any(Object),
      loopId: "loop-1",
      leaseOwnerToken: "daemon-event:event-1:1",
      guardrailRuntime: {
        killSwitchEnabled: false,
        cooldownUntil: null,
        maxIterations: null,
        manualIntentAllowed: true,
        iterationCount: 11,
      },
    });
  });

  it("does not force implementation transition when enrolled loop has already advanced state", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
      state: "blocked_on_ci",
      loopVersion: 11,
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);

    const response = await POST(
      createDaemonRequest({
        threadId: "thread-1",
        threadChatId: "chat-1",
        messages: [],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-non-enrolled",
        runId: "run-1",
        seq: 2,
      }),
    );

    expect(response.status).toBe(200);
    expect(runBestEffortSdlcSignalInboxTick).toHaveBeenCalledTimes(1);
    expect(runBestEffortSdlcPublicationCoordinator).toHaveBeenCalledTimes(1);
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
        messages: [],
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
        messages: [],
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
        messages: [],
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
    expect(runBestEffortSdlcSignalInboxTick).toHaveBeenCalledTimes(1);
    expect(runBestEffortSdlcPublicationCoordinator).toHaveBeenCalledTimes(1);
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
        messages: [],
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
    expect(runBestEffortSdlcSignalInboxTick).not.toHaveBeenCalled();
    expect(runBestEffortSdlcPublicationCoordinator).not.toHaveBeenCalled();
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
        messages: [],
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
    expect(runBestEffortSdlcSignalInboxTick).toHaveBeenCalledTimes(1);
    expect(runBestEffortSdlcPublicationCoordinator).toHaveBeenCalledTimes(1);
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
        messages: [],
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
    expect(runBestEffortSdlcSignalInboxTick).toHaveBeenCalledTimes(1);
    expect(runBestEffortSdlcPublicationCoordinator).toHaveBeenCalledTimes(1);
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
        messages: [],
        timezone: "UTC",
        payloadVersion: 2,
        eventId: "event-committed-elsewhere",
        runId: "run-1",
        seq: 12,
      }),
    );

    expect(response.status).toBe(200);
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
    expect(runBestEffortSdlcSignalInboxTick).toHaveBeenCalledTimes(1);
    expect(runBestEffortSdlcPublicationCoordinator).toHaveBeenCalledTimes(1);
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
        messages: [],
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
    expect(runBestEffortSdlcSignalInboxTick).not.toHaveBeenCalled();
    expect(runBestEffortSdlcPublicationCoordinator).not.toHaveBeenCalled();
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
        messages: [],
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
    expect(runBestEffortSdlcSignalInboxTick).toHaveBeenCalledTimes(1);
    expect(runBestEffortSdlcPublicationCoordinator).toHaveBeenCalledTimes(1);
  });
});
