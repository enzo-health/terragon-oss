import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { GET } from "./route";
import { getSessionOrNull } from "@/lib/auth-server";
import { getAgUiEventsForReplay } from "@terragon/shared/model/agent-event-log";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const dbMocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    limit,
    where,
    from,
    select,
    db: { select },
  };
});

const redisMocks = vi.hoisted(() => {
  // Default: xread always hangs (never resolves) — simulates no live traffic.
  // Tests that need to exercise the subscribe loop override via mockImplementation.
  const xread = vi.fn<(...args: unknown[]) => Promise<unknown>>(
    () => new Promise(() => {}),
  );
  return { xread };
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
  },
}));

vi.mock("@terragon/shared/model/agent-event-log", () => ({
  getAgUiEventsForReplay: vi.fn(),
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
    dbMocks.limit.mockResolvedValue([{ id: "thread-1" }]);
    vi.mocked(getAgUiEventsForReplay).mockResolvedValue([]);
    redisMocks.xread.mockImplementation(() => new Promise(() => {}));
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

    const received = await readReplayBurst(response, replayEvents.length);
    expect(received).toEqual(replayEvents);
  });

  it("streams replay events from the shared helper regardless of underlying row shape", async () => {
    // The shim handles both AG-UI-native and envelope-v2 rows; at the
    // route level we exercise the helper's contract — it returns AG-UI
    // BaseEvents — so one mixed-origin replay set demonstrates the shape
    // compatibility. (Full shim coverage lives in
    // packages/shared/src/model/agent-event-log.test.ts.)
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
    const received = await readReplayBurst(response, replayEvents.length);
    expect(received).toEqual(replayEvents);
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
