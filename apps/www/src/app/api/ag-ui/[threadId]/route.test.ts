import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { GET } from "./route";
import { getSessionOrNull } from "@/lib/auth-server";
import {
  getActiveAgUiLifecycleAt,
  getAgUiEventsForReplay,
} from "@terragon/shared/model/agent-event-log";

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
  // xread hangs by default — live tail is not exercised by these tests.
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
  getAgUiEventsForReplay: vi.fn(),
  getActiveAgUiLifecycleAt: vi.fn(),
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
  // Guard against hangs — subscribe loop never returns.
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
  }
  return events;
}

function makeContext(threadId: string) {
  return { params: Promise.resolve({ threadId }) };
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(url);
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
    vi.mocked(getAgUiEventsForReplay).mockResolvedValue([]);
    vi.mocked(getActiveAgUiLifecycleAt).mockResolvedValue({
      textMessages: [],
      toolCalls: [],
    });
    redisMocks.xread.mockImplementation(() => new Promise(() => {}));
    redisMocks.xrevrange.mockImplementation(() => Promise.resolve({}));
  });

  it("returns 401 without a session", async () => {
    vi.mocked(getSessionOrNull).mockResolvedValue(null);
    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=0",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 when thread does not belong to the session user", async () => {
    dbMocks.limit.mockResolvedValue([]);
    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=0",
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
        "http://localhost/api/ag-ui/thread-a?threadChatId=chat-b&fromSeq=0",
      ),
      makeContext("thread-a"),
    );
    expect(response.status).toBe(404);
    // Prove we ran the join — not the single-table `thread` lookup.
    expect(dbMocks.innerJoin).toHaveBeenCalled();
    // Replay should NOT be called when ownership fails.
    expect(getAgUiEventsForReplay).not.toHaveBeenCalled();
  });

  it("returns 400 when threadChatId is missing", async () => {
    const response = await GET(
      makeRequest("http://localhost/api/ag-ui/thread-1?fromSeq=0"),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing threadChatId",
    });
  });

  it("returns 400 when fromSeq is missing", async () => {
    const response = await GET(
      makeRequest("http://localhost/api/ag-ui/thread-1?threadChatId=chat-1"),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing replay cursor (fromSeq)",
    });
  });

  it("returns 400 when fromSeq is negative", async () => {
    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=-1",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid fromSeq",
    });
  });

  it("returns 400 when fromSeq is not a number", async () => {
    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=abc",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when fromSeq has trailing garbage (stricter than parseInt)", async () => {
    // parseInt("12abc", 10) would happily return 12. Number("12abc") → NaN,
    // which Number.isInteger rejects. This test pins the stricter contract.
    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=12abc",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when fromSeq is a float", async () => {
    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=1.5",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(400);
  });

  it("streams the replay burst as AG-UI SSE events in order", async () => {
    const replayEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-1",
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
    vi.mocked(getAgUiEventsForReplay).mockResolvedValue(replayEvents);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=0",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-transform",
    );
    expect(getAgUiEventsForReplay).toHaveBeenCalledWith({
      db: dbMocks.db,
      threadChatId: "chat-1",
      fromSeq: 0,
    });

    // When the replay already contains a RUN_STARTED event (the natural
    // fromSeq=0 case), the route does NOT prepend a synthetic one — the
    // AG-UI client's verifier rejects two RUN_STARTEDs in the same run
    // with "Cannot send 'RUN_STARTED' while a run is still active".
    // The stored events pass through unchanged, in order.
    const received = await readReplayBurst(response, replayEvents.length);
    expect(received).toEqual(replayEvents);
  });

  it("streams replay events from the shared helper regardless of underlying row shape", async () => {
    // The shim handles both AG-UI-native and envelope-v2 rows; at the
    // route level we pin the helper call shape — the route passes fromSeq
    // straight through — so downstream shim coverage (in
    // packages/shared/src/model/agent-event-log.test.ts) is what the UI
    // inherits.
    const replayEvents: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 10,
        messageId: "msg-legacy",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: 11,
        toolCallId: "tc-modern",
        toolCallName: "Bash",
      } as BaseEvent,
    ];
    vi.mocked(getAgUiEventsForReplay).mockResolvedValue(replayEvents);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=3",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    expect(getAgUiEventsForReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        threadChatId: "chat-1",
        fromSeq: 3,
      }),
    );
    // Mid-run reconnect: replay has no RUN_STARTED (client consumed the
    // original in a prior stream), so the route prepends a synthetic one.
    // Skip the synthetic here and assert the shared-helper output comes
    // through unchanged.
    const received = await readReplayBurst(response, replayEvents.length + 1);
    expect(received[0]).toMatchObject({
      type: EventType.RUN_STARTED,
      threadId: "chat-1",
    });
    expect(received.slice(1)).toEqual(replayEvents);
  });

  it("does NOT prepend a synthetic RUN_STARTED when the replay already contains one", async () => {
    // Regression: the AG-UI client's verifier closes over per-run state
    // and throws "Cannot send 'RUN_STARTED' while a run is still active"
    // when a second RUN_STARTED arrives before a RUN_FINISHED. The route
    // must skip the synthetic prepend whenever the replay window carries
    // a real RUN_STARTED — that natural bracket opens the run for the
    // client.
    const replayEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-real",
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
      {
        type: EventType.RUN_FINISHED,
        timestamp: 4,
        threadId: "thread-1",
        runId: "run-real",
      } as BaseEvent,
    ];
    vi.mocked(getAgUiEventsForReplay).mockResolvedValue(replayEvents);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=0",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    const received = await readReplayBurst(response, replayEvents.length);
    // Exactly one RUN_STARTED in the output, and it's the real one.
    const runStartedCount = received.filter(
      (e) => e.type === EventType.RUN_STARTED,
    ).length;
    expect(runStartedCount).toBe(1);
    expect(received).toEqual(replayEvents);
  });

  it("captures the stream cursor BEFORE the replay query so in-flight writes are not dropped", async () => {
    const callOrder: string[] = [];
    redisMocks.xrevrange.mockImplementation(async () => {
      callOrder.push("xrevrange");
      return { "1700000000000-0": { event: "ignored" } };
    });
    vi.mocked(getAgUiEventsForReplay).mockImplementation(async () => {
      callOrder.push("replay");
      return [];
    });

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=0",
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

    // Cancel the hanging xread poll so the test completes cleanly.
    await response.body!.cancel();
  });

  it("progresses XREAD blockMS 2s → 4s → 6s on consecutive idle polls and resets after an event", async () => {
    // Empty, empty, empty, one entry, empty. Block values should be:
    //   2000 (first call, consecutiveEmpty=0)
    //   4000 (consecutiveEmpty=1)
    //   6000 (consecutiveEmpty=2)
    //   8000 (consecutiveEmpty=3) ← the one that RETURNS an entry
    //   2000 (reset after entry)
    //   4000 (growing again)
    // We assert the first 5 observed blockMS values.
    const blockValues: number[] = [];
    const deferred: Array<{ resolve: (v: unknown) => void }> = [];

    redisMocks.xread.mockImplementation((...args: unknown[]) => {
      const opts = args[2] as { blockMS?: number; count?: number } | undefined;
      blockValues.push(opts?.blockMS ?? -1);
      // Return different results based on call index so we can drive the
      // empty/non-empty progression deterministically.
      const callIndex = redisMocks.xread.mock.calls.length - 1;
      if (callIndex === 3) {
        // 4th call (0-indexed): return one entry, seq resets to MIN on next loop.
        return Promise.resolve([
          [
            "agui:thread:chat-1",
            [["1700000000000-0", ["event", JSON.stringify({ type: "TEST" })]]],
          ],
        ]);
      }
      // Empty result for all other calls — but hang on the 5th so the loop
      // doesn't busy-cycle before the test assertions run.
      if (callIndex >= 5) {
        return new Promise((resolve) => {
          deferred.push({ resolve });
        });
      }
      return Promise.resolve(null);
    });

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=0",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    // Allow the microtask queue to flush through the first 5 XREAD calls.
    // Each xread call resolves synchronously (for idx 0..4) so the while
    // loop should progress quickly without any real timer waits.
    await vi.waitFor(() => {
      expect(blockValues.length).toBeGreaterThanOrEqual(5);
    });

    // Pin the progression: 2s, 4s, 6s, 8s, reset to 2s after non-empty.
    expect(blockValues.slice(0, 5)).toEqual([2000, 4000, 6000, 8000, 2000]);

    // Clean up: cancel the response body so the pending xread promise is GC'd.
    await response.body!.cancel();
    for (const d of deferred) d.resolve(null);
  });

  it("emits synthetic TEXT_MESSAGE_START and TOOL_CALL_START for lifecycles active at the cursor", async () => {
    // Simulate a reconnect mid-turn: the client's cursor sits inside an
    // in-progress assistant text message and an in-progress tool call. The
    // route must re-open both lifecycles so the subsequent CONTENT/ARGS
    // events from the stored replay don't reference unknown IDs.
    vi.mocked(getActiveAgUiLifecycleAt).mockResolvedValue({
      textMessages: [{ messageId: "msg-active" }],
      toolCalls: [{ toolCallId: "tc-active", toolCallName: "Bash" }],
    });
    const replayEvents: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 20,
        messageId: "msg-active",
        delta: "more text",
      } as BaseEvent,
    ];
    vi.mocked(getAgUiEventsForReplay).mockResolvedValue(replayEvents);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=47",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    expect(getActiveAgUiLifecycleAt).toHaveBeenCalledWith(
      expect.objectContaining({
        threadChatId: "chat-1",
        fromSeq: 47,
      }),
    );

    // Expected stream: RUN_STARTED → synthetic TEXT_MESSAGE_START →
    // synthetic TOOL_CALL_START → stored replay CONTENT.
    const received = await readReplayBurst(response, 4);
    expect(received).toHaveLength(4);
    expect(received[0]).toMatchObject({ type: EventType.RUN_STARTED });
    expect(received[1]).toMatchObject({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-active",
      role: "assistant",
    });
    expect(received[2]).toMatchObject({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-active",
      toolCallName: "Bash",
    });
    expect(received[3]).toMatchObject({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-active",
      delta: "more text",
    });
  });

  it("continues the replay when active-state reconstruction throws", async () => {
    // Best-effort contract: a failure in the active-state scan must not
    // take down the whole stream — the existing RUN_STARTED + replay flow
    // should still proceed.
    vi.mocked(getActiveAgUiLifecycleAt).mockRejectedValue(
      new Error("scan failed"),
    );
    const replayEvents: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: 30,
        messageId: "msg-1",
      } as BaseEvent,
    ];
    vi.mocked(getAgUiEventsForReplay).mockResolvedValue(replayEvents);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=5",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    const received = await readReplayBurst(response, 2);
    expect(received[0]).toMatchObject({ type: EventType.RUN_STARTED });
    expect(received[1]).toMatchObject({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-1",
    });
    warnSpy.mockRestore();
  });

  it("emits a RUN_ERROR event when the replay query fails", async () => {
    vi.mocked(getAgUiEventsForReplay).mockRejectedValue(
      new Error("db exploded"),
    );
    // Suppress console.error noise from the route's error handler during
    // this test — the route intentionally logs before closing.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=0",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    // The route now loads the replay BEFORE deciding whether to prepend
    // a synthetic RUN_STARTED (so it can inspect the replay for an
    // existing one). When the replay query fails, the error path emits
    // only RUN_ERROR — which the AG-UI verifier accepts as a valid
    // first event (see the "First event must be RUN_STARTED or RUN_ERROR"
    // check in @ag-ui/client/dist/index.mjs).
    const received = await readReplayBurst(response, 1);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "db exploded",
      code: "replay_failed",
    });

    errorSpy.mockRestore();
  });
});
