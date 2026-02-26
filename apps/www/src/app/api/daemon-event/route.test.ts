import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { getUserIdOrNullFromDaemonToken } from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { getActiveSdlcLoopForThread } from "@terragon/shared/model/sdlc-loop";
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
  getUserIdOrNullFromDaemonToken: vi.fn(),
}));

vi.mock("@/server-lib/handle-daemon-event", () => ({
  handleDaemonEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: dbMocks.db,
}));

vi.mock("@terragon/shared/model/feature-flags", () => ({
  getFeatureFlagForUser: vi.fn(),
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

function createDaemonRequest(
  body: Record<string, unknown>,
  headers: HeadersInit = {},
) {
  return new Request("http://localhost/api/daemon-event", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("daemon-event route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserIdOrNullFromDaemonToken).mockResolvedValue("user-1");
    vi.mocked(getFeatureFlagForUser).mockResolvedValue(true);
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
    vi.mocked(getUserIdOrNullFromDaemonToken).mockResolvedValue(null);

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

    expect(response.status).toBe(409);
    expect(data.error).toBe("enrolled_loop_requires_v2_envelope");
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

    expect(response.status).toBe(409);
    expect(data.error).toBe("enrolled_loop_requires_v2_envelope");
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

  it("allows legacy envelopes when coordinator routing flag is disabled", async () => {
    vi.mocked(getFeatureFlagForUser).mockResolvedValue(false);
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

    expect(response.status).toBe(200);
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
    expect(dbMocks.insert).not.toHaveBeenCalled();
    expect(runBestEffortSdlcSignalInboxTick).not.toHaveBeenCalled();
    expect(runBestEffortSdlcPublicationCoordinator).not.toHaveBeenCalled();
  });

  it("accepts enrolled-loop daemon events with v2 envelope", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
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

  it("recovers stale unprocessed daemon-event claims as duplicate events to avoid deadlock", async () => {
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

    expect(response.status).toBe(202);
    expect(data.reason).toBe("duplicate_event");
    expect(handleDaemonEvent).not.toHaveBeenCalled();
    expect(dbMocks.update).toHaveBeenCalledTimes(1);
    expect(dbMocks.deleteFrom).not.toHaveBeenCalled();
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
