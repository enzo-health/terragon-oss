import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { getUserIdOrNullFromDaemonToken } from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { getActiveSdlcLoopForThread } from "@terragon/shared/model/sdlc-loop";

const dbMocks = vi.hoisted(() => {
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

  return {
    selectWhere,
    selectFrom,
    select,
    insertReturning,
    insertOnConflictDoNothing,
    insertValues,
    insert,
    db: { select, insert },
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

function createDaemonRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/daemon-event", {
    method: "POST",
    headers: {
      "content-type": "application/json",
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
    dbMocks.selectWhere.mockResolvedValue([{ maxSeq: null }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: "signal-1" }]);
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

  it("rejects enrolled-loop daemon events without v2 envelope", async () => {
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
  });

  it("accepts enrolled-loop daemon events with v2 envelope", async () => {
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
        payloadVersion: 2,
        eventId: "event-1",
        runId: "run-1",
        seq: 1,
      }),
    );

    expect(response.status).toBe(200);
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
  });

  it("deduplicates repeated daemon envelopes by event identity", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);
    dbMocks.insertReturning.mockResolvedValue([]);

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
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("deduplicates out-of-order daemon envelopes within the same run", async () => {
    vi.mocked(getActiveSdlcLoopForThread).mockResolvedValue({
      id: "loop-1",
      threadId: "thread-1",
    } as Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>);
    dbMocks.selectWhere.mockResolvedValue([{ maxSeq: 4 }]);

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
  });
});
