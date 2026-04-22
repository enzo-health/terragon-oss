import { type BaseEvent, EventType } from "@ag-ui/core";
import type { AgentRunContext } from "@terragon/shared/db/types";
import {
  getAgUiEventsForRun,
  getLatestRunIdForThreadChat,
} from "@terragon/shared/model/agent-event-log";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionOrNull } from "@/lib/auth-server";
import { GET } from "./route";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Ownership check is:
//   db.select(...).from(threadChat).innerJoin(thread, ...).where(...).limit(1)
// Mock the full chain so test cases can override the final `limit` result.
const dbMocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));
  return {
    limit,
    where,
    innerJoin,
    from,
    select,
    db: { select },
  };
});

const redisMocks = vi.hoisted(() => {
  // xread hangs by default — live tail is not exercised by most tests.
  const xread = vi.fn<(...args: unknown[]) => Promise<unknown>>(
    () => new Promise(() => {}),
  );
  // xrevrange returns empty by default — captureStreamCursor falls back to "0".
  const xrevrange = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
    Promise.resolve({}),
  );
  return { xread, xrevrange };
});

vi.mock("@/lib/auth-server", () => ({
  getSessionOrNull: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: dbMocks.db,
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    xread: redisMocks.xread,
    xrevrange: redisMocks.xrevrange,
  },
}));

vi.mock("@terragon/shared/model/agent-event-log", () => ({
  agUiStreamKey: (threadChatId: string) => `agui:thread:${threadChatId}`,
  getAgUiEventsForRun: vi.fn(),
  getLatestRunIdForThreadChat: vi.fn(),
  isTerminalAgentRunStatus: (status: string) =>
    status === "completed" || status === "failed" || status === "stopped",
}));

vi.mock("@terragon/shared/model/agent-run-context", () => ({
  getAgentRunContextByRunId: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readReplayBurst(
  response: Response,
  expectedEventCount: number,
): Promise<BaseEvent[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const events: BaseEvent[] = [];
  // Guard against hangs — live-tail loop never returns.
  const timeout = setTimeout(() => reader.cancel("test-timeout"), 1_000);
  try {
    while (events.length < expectedEventCount) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        events.push(JSON.parse(line.slice("data: ".length)) as BaseEvent);
      }
    }
  } finally {
    clearTimeout(timeout);
    await reader.cancel();
    reader.releaseLock();
  }
  return events;
}

function makeContext(threadId: string) {
  return { params: Promise.resolve({ threadId }) };
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(url);
}

function makeRunContext(
  overrides: Partial<AgentRunContext> &
    Pick<AgentRunContext, "runId" | "status">,
): AgentRunContext {
  const now = new Date();
  const { runId, status, ...rest } = overrides;
  return {
    runId,
    workflowId: null,
    runSeq: null,
    userId: "user-1",
    threadId: "thread-1",
    threadChatId: "chat-1",
    sandboxId: "sandbox-1",
    transportMode: "legacy",
    protocolVersion: 2,
    agent: "codex",
    permissionMode: "allowAll",
    requestedSessionId: null,
    resolvedSessionId: null,
    status,
    tokenNonce: "nonce-1",
    daemonTokenKeyId: null,
    failureCategory: null,
    failureSource: null,
    failureRetryable: null,
    failureSignatureHash: null,
    failureTerminalReason: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ag-ui SSE route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionOrNull).mockResolvedValue({
      session: {
        id: "session-1",
        userId: "user-1",
        expiresAt: new Date(),
        token: "token-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "User",
      },
    } as Awaited<ReturnType<typeof getSessionOrNull>>);
    // Default: ownership join returns one row (authorized).
    dbMocks.limit.mockResolvedValue([{ id: "chat-1" }]);
    vi.mocked(getAgUiEventsForRun).mockResolvedValue([]);
    vi.mocked(getLatestRunIdForThreadChat).mockResolvedValue(null);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue(null);
    redisMocks.xread.mockImplementation(() => new Promise(() => {}));
    redisMocks.xrevrange.mockImplementation(() => Promise.resolve({}));
  });

  it("returns 401 without a session", async () => {
    vi.mocked(getSessionOrNull).mockResolvedValue(null);
    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-1",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 when thread does not belong to the session user", async () => {
    dbMocks.limit.mockResolvedValue([]);
    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-1",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when threadChatId belongs to a different thread", async () => {
    // The ownership query is a JOIN that filters on
    //   threadChat.id = threadChatId AND thread.id = threadId AND thread.userId = session.user.id
    // If threadChatId belongs to some other thread, the join returns 0 rows.
    dbMocks.limit.mockResolvedValue([]);
    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-a?threadChatId=chat-b&runId=run-1",
      ),
      makeContext("thread-a"),
    );
    expect(response.status).toBe(404);
    // Prove we ran the join — not the single-table `thread` lookup.
    expect(dbMocks.innerJoin).toHaveBeenCalled();
    // Replay should NOT be called when ownership fails.
    expect(getAgUiEventsForRun).not.toHaveBeenCalled();
  });

  it("returns 400 when threadChatId is missing", async () => {
    const response = await GET(
      makeRequest("http://localhost/api/ag-ui/thread-1?runId=run-1"),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing threadChatId",
    });
  });

  it("streams the full run event log without synthesis when replay starts with RUN_STARTED", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "chat-1",
        runId: "run-42",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 2,
        messageId: "msg-1",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: 3,
        messageId: "msg-1",
      } as BaseEvent,
    ];
    vi.mocked(getAgUiEventsForRun).mockResolvedValue(runEvents);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-42",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(getAgUiEventsForRun).toHaveBeenCalledWith({
      db: dbMocks.db,
      runId: "run-42",
    });
    // When the caller supplies an explicit runId, the server MUST NOT fall
    // back to the "latest run" helper.
    expect(getLatestRunIdForThreadChat).not.toHaveBeenCalled();

    const received = await readReplayBurst(response, runEvents.length);
    // Natural bracket: events as stored, no synthetic RUN_STARTED prepend.
    expect(received).toEqual(runEvents);
    const runStartedCount = received.filter(
      (e) => e.type === EventType.RUN_STARTED,
    ).length;
    expect(runStartedCount).toBe(1);
  });

  it("synthesizes a terminal SSE event from durable run status when replay misses it", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-terminal",
      } as BaseEvent,
    ];
    vi.mocked(getAgUiEventsForRun).mockResolvedValue(runEvents);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue(
      makeRunContext({ runId: "run-terminal", status: "completed" }),
    );

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-terminal",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const received = await readReplayBurst(response, 2);
    expect(received).toEqual([
      runEvents[0],
      expect.objectContaining({
        type: EventType.RUN_FINISHED,
        threadId: "thread-1",
        runId: "run-terminal",
      }),
    ]);
    expect(redisMocks.xread).not.toHaveBeenCalled();
  });

  it("closes the stream immediately after RUN_FINISHED on a complete run", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "chat-1",
        runId: "run-done",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 2,
        threadId: "chat-1",
        runId: "run-done",
      } as BaseEvent,
    ];
    vi.mocked(getAgUiEventsForRun).mockResolvedValue(runEvents);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-done",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    // Drain the stream fully. If the route failed to close, this read
    // would stall on the live-tail XREAD poll; the timeout would cancel
    // it. We assert `done:true` is reached, which requires a clean close —
    // not a timeout cancel.
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const events: BaseEvent[] = [];
    const timeout = setTimeout(() => reader.cancel("test-timeout"), 2_000);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const frames = buffered.split("\n\n");
        buffered = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          events.push(JSON.parse(line.slice("data: ".length)) as BaseEvent);
        }
      }
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
    }
    expect(events).toEqual(runEvents);
    // Live tail was NOT entered — xread must not have been called.
    expect(redisMocks.xread).not.toHaveBeenCalled();
  });

  it("live-tails via XREAD when the run is still active (no RUN_FINISHED yet)", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "chat-1",
        runId: "run-live",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 2,
        messageId: "msg-live",
        role: "assistant",
      } as BaseEvent,
    ];
    vi.mocked(getAgUiEventsForRun).mockResolvedValue(runEvents);
    // xread hangs (default) — we just need to observe it was called.
    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-live",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const received = await readReplayBurst(response, runEvents.length);
    expect(received).toEqual(runEvents);
    // Allow the async loop to settle so the xread call has been issued.
    // readReplayBurst cancels the reader on cleanup, which also releases
    // the lock on response.body — no further cleanup needed here.
    await vi.waitFor(() => {
      expect(redisMocks.xread).toHaveBeenCalled();
    });
  });

  it("keeps live-tailing a RUN_STARTED-only run when durable status is still processing", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-processing",
      } as BaseEvent,
    ];
    vi.mocked(getAgUiEventsForRun).mockResolvedValue(runEvents);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue(
      makeRunContext({ runId: "run-processing", status: "processing" }),
    );

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-processing",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(redisMocks.xread).toHaveBeenCalled();
    });
    await response.body!.cancel();
  });

  it("emits RUN_FINISHED and closes during live-tail when durable status turns terminal but the stream stays idle", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-idle-terminal",
      } as BaseEvent,
    ];
    vi.mocked(getAgUiEventsForRun).mockResolvedValue(runEvents);
    vi.mocked(getAgentRunContextByRunId)
      .mockResolvedValueOnce(
        makeRunContext({ runId: "run-idle-terminal", status: "processing" }),
      )
      .mockResolvedValueOnce(
        makeRunContext({ runId: "run-idle-terminal", status: "completed" }),
      );

    redisMocks.xread.mockImplementation(() => {
      const callIndex = redisMocks.xread.mock.calls.length;
      if (callIndex <= 2) {
        return Promise.resolve(null);
      }
      return new Promise(() => {});
    });

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-idle-terminal",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const events: BaseEvent[] = [];
    const timeout = setTimeout(() => reader.cancel("test-timeout"), 2_000);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const frames = buffered.split("\n\n");
        buffered = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          events.push(JSON.parse(line.slice("data: ".length)) as BaseEvent);
        }
      }
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
    }

    expect(events[0]).toMatchObject({ type: EventType.RUN_STARTED });
    expect(events[1]).toMatchObject({
      type: EventType.RUN_FINISHED,
      runId: "run-idle-terminal",
    });
    expect(redisMocks.xread).toHaveBeenCalled();
  });

  it("closes the stream after receiving a terminal marker via XREAD", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-from-stream",
      } as BaseEvent,
    ];
    vi.mocked(getAgUiEventsForRun).mockResolvedValue(runEvents);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue(
      makeRunContext({ runId: "run-from-stream", status: "processing" }),
    );

    redisMocks.xread.mockResolvedValueOnce([
      [
        "agui:thread:chat-1",
        [
          [
            "1700000000000-0",
            [
              "event",
              JSON.stringify({
                type: EventType.RUN_FINISHED,
                timestamp: 2,
                threadId: "thread-1",
                runId: "run-from-stream",
              }),
            ],
          ],
        ],
      ],
    ]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-from-stream",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const events: BaseEvent[] = [];
    const timeout = setTimeout(() => reader.cancel("test-timeout"), 2_000);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const frames = buffered.split("\n\n");
        buffered = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          events.push(JSON.parse(line.slice("data: ".length)) as BaseEvent);
        }
      }
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
    }

    expect(events).toMatchObject([
      { type: EventType.RUN_STARTED },
      { type: EventType.RUN_FINISHED, runId: "run-from-stream" },
    ]);
  });

  it("emits RUN_ERROR and closes when the run has no events", async () => {
    vi.mocked(getAgUiEventsForRun).mockResolvedValue([]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-missing",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    const received = await readReplayBurst(response, 1);
    expect(received[0]).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "run_not_found",
    });
    expect(redisMocks.xread).not.toHaveBeenCalled();
  });

  it("emits RUN_ERROR when the stored log does not start with RUN_STARTED", async () => {
    // Loud surface for log corruption — the contract is that the events
    // query naturally begins with RUN_STARTED. If it doesn't, the fix
    // lives in the writer, not in reader synthesis.
    const malformed: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 10,
        messageId: "msg-x",
        delta: "hi",
      } as BaseEvent,
    ];
    vi.mocked(getAgUiEventsForRun).mockResolvedValue(malformed);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-broken",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    const received = await readReplayBurst(response, 1);
    expect(received[0]).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "replay_failed",
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("emits RUN_ERROR when getAgUiEventsForRun throws", async () => {
    vi.mocked(getAgUiEventsForRun).mockRejectedValue(new Error("db exploded"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-boom",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    const received = await readReplayBurst(response, 1);
    expect(received[0]).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "db exploded",
      code: "replay_failed",
    });
    errorSpy.mockRestore();
  });

  it("captures the stream cursor BEFORE the replay query so in-flight writes are not dropped", async () => {
    const callOrder: string[] = [];
    redisMocks.xrevrange.mockImplementation(async () => {
      callOrder.push("xrevrange");
      return { "1700000000000-0": { event: "ignored" } };
    });
    vi.mocked(getAgUiEventsForRun).mockImplementation(async () => {
      callOrder.push("replay");
      return [];
    });

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-cursor",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    // xrevrange must run before replay so the live-tail cursor pins the
    // stream's end BEFORE the DB read window.
    expect(callOrder).toEqual(["xrevrange", "replay"]);
    expect(redisMocks.xrevrange).toHaveBeenCalledWith(
      "agui:thread:chat-1",
      "+",
      "-",
      1,
    );

    // Drain any remaining frames so the stream closes cleanly.
    await response.body!.cancel();
  });

  // -------------------------------------------------------------------
  // Default "latest run" fallback — Phase B cutover.
  //
  // When neither `runId` nor any other cursor is supplied, the route
  // resolves the thread chat's most recent run and replays from there.
  // Clients that land on a thread chat with zero runs get a keepalive
  // comment plus a live-tail — the first real RUN_STARTED written by a
  // new daemon-event becomes the first event on the wire.
  // -------------------------------------------------------------------

  it("defaults to latest run when neither runId nor fromSeq is provided", async () => {
    vi.mocked(getLatestRunIdForThreadChat).mockResolvedValue("run-latest");
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "chat-1",
        runId: "run-latest",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 2,
        threadId: "chat-1",
        runId: "run-latest",
      } as BaseEvent,
    ];
    vi.mocked(getAgUiEventsForRun).mockResolvedValue(runEvents);

    const response = await GET(
      makeRequest("http://localhost/api/ag-ui/thread-1?threadChatId=chat-1"),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    expect(getLatestRunIdForThreadChat).toHaveBeenCalledWith({
      db: dbMocks.db,
      threadChatId: "chat-1",
    });
    expect(getAgUiEventsForRun).toHaveBeenCalledWith({
      db: dbMocks.db,
      runId: "run-latest",
    });
    // Drain to let the stream close cleanly on RUN_FINISHED.
    const reader = response.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    reader.releaseLock();
  });

  it("defaults to latest run for RUN_STARTED-only runs and live-tails (no awaiting-first-run)", async () => {
    vi.mocked(getLatestRunIdForThreadChat).mockResolvedValue("run-start-only");
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-start-only",
      } as BaseEvent,
    ];
    vi.mocked(getAgUiEventsForRun).mockResolvedValue(runEvents);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue(
      makeRunContext({ runId: "run-start-only", status: "processing" }),
    );

    const response = await GET(
      makeRequest("http://localhost/api/ag-ui/thread-1?threadChatId=chat-1"),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const received = await readReplayBurst(response, 1);
    expect(received).toEqual(runEvents);

    await vi.waitFor(() => {
      expect(redisMocks.xread).toHaveBeenCalled();
    });
    await response.body!.cancel();
  });

  it("keeps the stream open and live-tails when the thread chat has no runs yet", async () => {
    vi.mocked(getLatestRunIdForThreadChat).mockResolvedValue(null);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-new?threadChatId=chat-empty",
      ),
      makeContext("thread-new"),
    );
    expect(response.status).toBe(200);
    // The DB replay helper must NOT be called when there's no run to
    // replay.
    expect(getAgUiEventsForRun).not.toHaveBeenCalled();
    // Live tail engaged: xread is called to poll for the first real
    // RUN_STARTED written by an incoming daemon-event.
    await vi.waitFor(() => {
      expect(redisMocks.xread).toHaveBeenCalled();
    });
    await response.body!.cancel();
  });

  it("treats a missing getLatestRunIdForThreadChat as an empty-thread case (defensive)", async () => {
    vi.mocked(getLatestRunIdForThreadChat).mockRejectedValue(
      new Error("db transient"),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-transient",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    // The fallback path must NOT take down the stream — we log and proceed
    // to live-tail.
    expect(getAgUiEventsForRun).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(redisMocks.xread).toHaveBeenCalled();
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    await response.body!.cancel();
  });

  it("progresses XREAD blockMS 2s → 4s → 6s on consecutive idle polls and resets after an event", async () => {
    // Empty, empty, empty, one entry, empty. Block values should be:
    //   2000 (first call, consecutiveEmpty=0)
    //   4000 (consecutiveEmpty=1)
    //   6000 (consecutiveEmpty=2)
    //   8000 (consecutiveEmpty=3) ← the one that RETURNS an entry
    //   2000 (reset after entry)
    // We assert the first 5 observed blockMS values.
    const blockValues: number[] = [];
    const deferred: Array<{ resolve: (v: unknown) => void }> = [];

    redisMocks.xread.mockImplementation((...args: unknown[]) => {
      const opts = args[2] as { blockMS?: number; count?: number } | undefined;
      blockValues.push(opts?.blockMS ?? -1);
      const callIndex = redisMocks.xread.mock.calls.length - 1;
      if (callIndex === 3) {
        return Promise.resolve([
          [
            "agui:thread:chat-empty",
            [["1700000000000-0", ["event", JSON.stringify({ type: "TEST" })]]],
          ],
        ]);
      }
      if (callIndex >= 5) {
        return new Promise((resolve) => {
          deferred.push({ resolve });
        });
      }
      return Promise.resolve(null);
    });

    // Drive through the no-history path so live-tail kicks in without a
    // prior DB replay.
    vi.mocked(getLatestRunIdForThreadChat).mockResolvedValue(null);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-empty",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    await vi.waitFor(() => {
      expect(blockValues.length).toBeGreaterThanOrEqual(5);
    });

    // Pin the progression: 2s, 4s, 6s, 8s, reset to 2s after non-empty.
    expect(blockValues.slice(0, 5)).toEqual([2000, 4000, 6000, 8000, 2000]);

    await response.body!.cancel();
    for (const d of deferred) d.resolve(null);
  });
});
