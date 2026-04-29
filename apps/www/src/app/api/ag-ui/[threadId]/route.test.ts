import { type BaseEvent, EventType } from "@ag-ui/core";
import type { AgentRunContext } from "@terragon/shared/db/types";
import {
  getAgUiEventEnvelopesForRun,
  getAgUiEventEnvelopesForThreadChat,
  getLatestRunIdForThreadChat,
} from "@terragon/shared/model/agent-event-log";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionOrNull } from "@/lib/auth-server";
import { GET, POST } from "./route";

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
  const isLocalRedisHttpMode = vi.fn(() => false);
  return { xread, xrevrange, isLocalRedisHttpMode };
});

vi.mock("@/lib/auth-server", () => ({
  getSessionOrNull: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: dbMocks.db,
}));

vi.mock("@/lib/redis", () => ({
  isLocalRedisHttpMode: redisMocks.isLocalRedisHttpMode,
  redis: {
    xread: redisMocks.xread,
    xrevrange: redisMocks.xrevrange,
  },
}));

vi.mock("@terragon/shared/model/agent-event-log", () => ({
  agUiStreamKey: (threadChatId: string) => `agui:thread:${threadChatId}`,
  getAgUiEventEnvelopesForRun: vi.fn(),
  getAgUiEventEnvelopesForThreadChat: vi.fn(),
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

type ParsedSseFrame = {
  comment: string | null;
  id: string | null;
  event: BaseEvent | null;
};

function parseSseFrame(frame: string): ParsedSseFrame {
  const lines = frame.split("\n");
  const idLine = lines.find((line) => line.startsWith("id: "));
  const commentLine = lines.find((line) => line.startsWith(":"));
  if (commentLine) {
    return {
      comment: commentLine.slice(1).trimStart(),
      id: idLine?.slice("id: ".length) ?? null,
      event: null,
    };
  }

  const dataLine = lines.find((line) => line.startsWith("data: "));
  if (!dataLine) {
    return {
      comment: null,
      id: idLine?.slice("id: ".length) ?? null,
      event: null,
    };
  }

  return {
    comment: null,
    id: idLine?.slice("id: ".length) ?? null,
    event: JSON.parse(dataLine.slice("data: ".length)) as BaseEvent,
  };
}

async function readFirstSseFrames(
  response: Response,
  expectedFrameCount: number,
): Promise<ParsedSseFrame[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const frames: ParsedSseFrame[] = [];
  const timeout = setTimeout(() => reader.cancel("test-timeout"), 1_000);
  try {
    while (frames.length < expectedFrameCount) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const chunks = buffered.split("\n\n");
      buffered = chunks.pop() ?? "";
      for (const chunk of chunks) {
        if (chunk.trim().length === 0) {
          continue;
        }
        frames.push(parseSseFrame(chunk));
        if (frames.length >= expectedFrameCount) {
          break;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    await reader.cancel();
    reader.releaseLock();
  }
  return frames;
}

function makeContext(threadId: string) {
  return { params: Promise.resolve({ threadId }) };
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(url);
}

function makeRequestWithHeaders(
  url: string,
  headers: Record<string, string>,
): NextRequest {
  return new NextRequest(url, { headers });
}

function makeRunContext(
  overrides: Partial<AgentRunContext> &
    Pick<AgentRunContext, "runId" | "status">,
): AgentRunContext {
  const now = new Date();
  const { runId, status, ...rest } = overrides;
  return {
    runId,
    userId: "user-1",
    threadId: "thread-1",
    threadChatId: "chat-1",
    sandboxId: "sandbox-1",
    transportMode: "legacy",
    protocolVersion: 2,
    agent: "codex",
    permissionMode: "allowAll",
    status,
    tokenNonce: "nonce-1",
    createdAt: now,
    updatedAt: now,
    ...rest,
    requestedSessionId: rest.requestedSessionId ?? null,
    resolvedSessionId: rest.resolvedSessionId ?? null,
    runtimeProvider: rest.runtimeProvider ?? null,
    externalSessionId: rest.externalSessionId ?? null,
    previousResponseId: rest.previousResponseId ?? null,
    checkpointPointer: rest.checkpointPointer ?? null,
    hibernationValid: rest.hibernationValid ?? null,
    compactionGeneration: rest.compactionGeneration ?? null,
    lastAcceptedSeq: rest.lastAcceptedSeq ?? null,
    terminalEventId: rest.terminalEventId ?? null,
    failureCategory: rest.failureCategory ?? null,
    failureSource: rest.failureSource ?? null,
    failureRetryable: rest.failureRetryable ?? null,
    failureSignatureHash: rest.failureSignatureHash ?? null,
    failureTerminalReason: rest.failureTerminalReason ?? null,
    daemonTokenKeyId: rest.daemonTokenKeyId ?? null,
  };
}

function mockAgUiEventEnvelopesForThreadChat(
  events: BaseEvent[],
  seqs?: number[],
): void {
  let currentRunId: string | null = null;
  const envelopes = events.map((payload, index) => {
    const seq = seqs?.[index] ?? index;
    const payloadRunId = readRunId(payload);
    if (payload.type === EventType.RUN_STARTED) {
      currentRunId = payloadRunId;
    }
    const runId =
      payload.type === EventType.MESSAGES_SNAPSHOT
        ? payloadRunId
        : (currentRunId ?? payloadRunId);
    return {
      eventId: `event-${seq}`,
      seq,
      runId,
      threadId: "thread-1",
      threadChatId: "chat-1",
      timestamp: String(index + 1),
      idempotencyKey: `event-${seq}`,
      payload,
    };
  });
  vi.mocked(getAgUiEventEnvelopesForThreadChat).mockImplementation(
    async ({ afterSeq }) =>
      envelopes.filter(
        (entry) => afterSeq === undefined || entry.seq > afterSeq,
      ),
  );
  vi.mocked(getAgUiEventEnvelopesForRun).mockImplementation(
    async ({ runId, threadChatId }) =>
      envelopes.filter(
        (entry) =>
          entry.runId === runId &&
          (threadChatId === undefined || entry.threadChatId === threadChatId),
      ),
  );
}

function readRunId(event: BaseEvent): string {
  if (event && typeof event === "object") {
    const runId = Reflect.get(event, "runId");
    if (typeof runId === "string") {
      return runId;
    }
  }
  return "run-1";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ag-ui SSE route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMocks.xread.mockReset();
    redisMocks.xrevrange.mockReset();
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
    dbMocks.limit.mockResolvedValue([
      { id: "chat-1", messages: [], threadName: null },
    ]);
    mockAgUiEventEnvelopesForThreadChat([]);
    vi.mocked(getLatestRunIdForThreadChat).mockResolvedValue(null);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue(null);
    redisMocks.xread.mockImplementation(() => new Promise(() => {}));
    redisMocks.xrevrange.mockImplementation(() => Promise.resolve({}));
    redisMocks.isLocalRedisHttpMode.mockReturnValue(false);
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
    expect(getAgUiEventEnvelopesForThreadChat).not.toHaveBeenCalled();
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

  it("returns native history messages with the durable replay cursor", async () => {
    const snapshotEvent = {
      type: EventType.MESSAGES_SNAPSHOT,
      timestamp: 1,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "start here",
        },
      ],
    } as BaseEvent;
    mockAgUiEventEnvelopesForThreadChat([snapshotEvent], [42]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&history=messages",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "start here",
        },
      ],
      lastSeq: 42,
    });
  });

  it("returns runtime-owned assistant text, tool calls, tool results, and custom parts in history", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 1,
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "start here",
          },
        ],
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 2,
        messageId: "assistant-1",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 3,
        messageId: "assistant-1",
        delta: "I will inspect it.",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: 4,
        toolCallId: "tool-1",
        toolCallName: "Bash",
        parentMessageId: "assistant-1",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: 5,
        toolCallId: "tool-1",
        delta: '{"command":"pnpm test"}',
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        timestamp: 6,
        messageId: "tool-result-1",
        toolCallId: "tool-1",
        content: "passed",
      } as BaseEvent,
      {
        type: EventType.CUSTOM,
        timestamp: 7,
        name: "terragon.data-part",
        value: {
          messageId: "assistant-1",
          partIndex: 1,
          name: "terragon.terminal",
          data: {
            type: "terminal",
            sandboxId: "sandbox-1",
            terminalId: "terminal-1",
            chunks: [],
          },
        },
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(
      runEvents,
      [10, 20, 30, 40, 50, 60, 70],
    );

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&history=messages",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "start here",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "I will inspect it.",
          toolCalls: [
            {
              id: "tool-1",
              type: "function",
              function: {
                name: "Bash",
                arguments: '{"command":"pnpm test"}',
              },
            },
          ],
        },
        {
          id: "tool-result-1",
          role: "tool",
          toolCallId: "tool-1",
          content: "passed",
        },
        {
          type: EventType.CUSTOM,
          timestamp: 7,
          name: "terragon.data-part",
          value: {
            messageId: "assistant-1",
            partIndex: 1,
            name: "terragon.terminal",
            data: {
              type: "terminal",
              sandboxId: "sandbox-1",
              terminalId: "terminal-1",
              chunks: [],
            },
          },
        },
      ],
      lastSeq: 70,
    });
  });

  it("advances the history cursor through represented terminal run events", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 1,
        messageId: "assistant-1",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 2,
        messageId: "assistant-1",
        delta: "Visible history",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 3,
        threadId: "chat-1",
        runId: "run-1",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents, [11, 21, 31]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&history=messages",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "Visible history",
        },
      ],
      lastSeq: 31,
    });
  });

  it("uses repaired event order when returning the history replay cursor", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 1,
        messages: [{ id: "user-1", role: "user", content: "start here" }],
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 2,
        messageId: "assistant-1",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 3,
        messageId: "assistant-1",
        delta: "Visible before start marker",
      } as BaseEvent,
      {
        type: EventType.RUN_STARTED,
        timestamp: 4,
        threadId: "thread-1",
        runId: "run-1",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: 5,
        messageId: "assistant-1",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 6,
        threadId: "thread-1",
        runId: "run-1",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents, [10, 20, 30, 40, 50, 60]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&history=messages",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messages: [
        { id: "user-1", role: "user", content: "start here" },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Visible before start marker",
        },
      ],
      lastSeq: 60,
    });
  });

  it("seeds missing db user messages into native history without moving the replay cursor", async () => {
    dbMocks.limit.mockResolvedValue([
      {
        id: "chat-1",
        messages: [
          {
            type: "user",
            model: "sonnet",
            parts: [{ type: "text", text: "initial prompt" }],
            timestamp: "2026-04-29T00:00:00.000Z",
          },
        ],
      },
    ]);
    const runEvents: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 1,
        messageId: "assistant-1",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 2,
        messageId: "assistant-1",
        delta: "Visible history",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 3,
        threadId: "chat-1",
        runId: "run-1",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents, [11, 21, 31]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&history=messages",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messages: [
        {
          id: expect.stringMatching(/^side-effect-user-0-/),
          role: "user",
          content: "initial prompt",
          name: "terragon-user:model=sonnet",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Visible history",
        },
      ],
      lastSeq: 31,
    });
  });

  it("preserves repeated missing db user messages when merging native history", async () => {
    dbMocks.limit.mockResolvedValue([
      {
        id: "chat-1",
        messages: [
          {
            type: "user",
            model: "sonnet",
            parts: [{ type: "text", text: "Continue" }],
            timestamp: "2026-04-29T00:00:00.000Z",
          },
          {
            type: "user",
            model: "sonnet",
            parts: [{ type: "text", text: "Continue" }],
            timestamp: "2026-04-29T00:01:00.000Z",
          },
        ],
      },
    ]);
    const runEvents: BaseEvent[] = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 1,
        messages: [
          {
            id: "native-user-1",
            role: "user",
            content: "Continue",
            name: "terragon-user:model=sonnet",
          },
        ],
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 2,
        messageId: "assistant-1",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 3,
        messageId: "assistant-1",
        delta: "Working.",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents, [1, 2, 3]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&history=messages",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      messages: [
        {
          id: "native-user-1",
          role: "user",
          content: "Continue",
          name: "terragon-user:model=sonnet",
        },
        {
          id: expect.stringMatching(/^side-effect-user-/),
          role: "user",
          content: "Continue",
          name: "terragon-user:model=sonnet",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Working.",
        },
      ],
      lastSeq: 3,
    });
  });

  it("keeps post-terminal follow-up user snapshots in native history", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "chat-1",
        runId: "run-before-follow-up",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 2,
        messageId: "assistant-1",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 3,
        messageId: "assistant-1",
        delta: "First run done.",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 4,
        threadId: "chat-1",
        runId: "run-before-follow-up",
      } as BaseEvent,
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 5,
        messages: [
          {
            id: "side-effect-user-follow-up",
            role: "user",
            content: "follow-up prompt",
          },
        ],
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents, [11, 21, 31, 41, 51]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&history=messages",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "First run done.",
        },
        {
          id: "side-effect-user-follow-up",
          role: "user",
          content: "follow-up prompt",
        },
      ],
      lastSeq: 51,
    });
  });

  it("seeds the thread title when no user message was persisted anywhere", async () => {
    dbMocks.limit.mockResolvedValue([
      {
        id: "chat-1",
        messages: null,
        threadName: "add a test to scheduling",
      },
    ]);
    const runEvents: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 1,
        messageId: "assistant-1",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 2,
        messageId: "assistant-1",
        delta: "Visible history",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents, [11, 21]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&history=messages",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messages: [
        {
          id: "thread-title-user-prompt",
          role: "user",
          content: "add a test to scheduling",
          name: "terragon-user:source=thread-title",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Visible history",
        },
      ],
      lastSeq: 21,
    });
  });

  it("does not duplicate db user messages already present in native history", async () => {
    dbMocks.limit.mockResolvedValue([
      {
        id: "chat-1",
        messages: [
          {
            type: "user",
            model: "sonnet",
            parts: [{ type: "text", text: "start here" }],
            timestamp: "2026-04-29T00:00:00.000Z",
          },
        ],
      },
    ]);
    const snapshotEvent = {
      type: EventType.MESSAGES_SNAPSHOT,
      timestamp: 1,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "start here",
        },
      ],
    } as BaseEvent;
    mockAgUiEventEnvelopesForThreadChat([snapshotEvent], [42]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&history=messages",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "start here",
        },
      ],
      lastSeq: 42,
    });
  });

  it("advances the history cursor through trailing represented end events", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 1,
        messageId: "assistant-1",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 2,
        messageId: "assistant-1",
        delta: "Visible history",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: 3,
        messageId: "assistant-1",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: 4,
        toolCallId: "tool-1",
        toolCallName: "Bash",
        parentMessageId: "assistant-1",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: 5,
        toolCallId: "tool-1",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents, [101, 111, 121, 131, 141]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&history=messages",
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "Visible history",
          toolCalls: [
            {
              id: "tool-1",
              type: "function",
              function: {
                name: "Bash",
                arguments: "",
              },
            },
          ],
        },
      ],
      lastSeq: 141,
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
    mockAgUiEventEnvelopesForThreadChat(runEvents);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-42",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(getAgUiEventEnvelopesForRun).toHaveBeenCalledWith({
      db: dbMocks.db,
      runId: "run-42",
      threadChatId: "chat-1",
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

  it("drops leading MESSAGES_SNAPSHOT rows before full replay RUN_STARTED", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 0,
        messages: [],
      } as BaseEvent,
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 1,
        messages: [],
      } as BaseEvent,
      {
        type: EventType.RUN_STARTED,
        timestamp: 2,
        threadId: "thread-1",
        runId: "run-snapshot-prefix",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 3,
        threadId: "thread-1",
        runId: "run-snapshot-prefix",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-snapshot-prefix",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const received = await readReplayBurst(response, 2);
    expect(received).toEqual(runEvents.slice(2));
  });

  it("repairs delayed RUN_STARTED before replaying early text deltas", async () => {
    const userSnapshot = {
      type: EventType.MESSAGES_SNAPSHOT,
      timestamp: 0,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "probe",
        },
      ],
    } as BaseEvent;
    const textStart = {
      type: EventType.TEXT_MESSAGE_START,
      timestamp: 1,
      messageId: "msg-delayed",
      role: "assistant",
    } as BaseEvent;
    const firstDelta = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      timestamp: 2,
      messageId: "msg-delayed",
      delta: "immediate",
    } as BaseEvent;
    const runStarted = {
      type: EventType.RUN_STARTED,
      timestamp: 3,
      threadId: "thread-1",
      runId: "run-1",
    } as BaseEvent;
    const secondDelta = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      timestamp: 4,
      messageId: "msg-delayed",
      delta: " visible",
    } as BaseEvent;
    const textEnd = {
      type: EventType.TEXT_MESSAGE_END,
      timestamp: 5,
      messageId: "msg-delayed",
    } as BaseEvent;
    const runFinished = {
      type: EventType.RUN_FINISHED,
      timestamp: 6,
      threadId: "thread-1",
      runId: "run-1",
    } as BaseEvent;
    mockAgUiEventEnvelopesForThreadChat([
      userSnapshot,
      textStart,
      firstDelta,
      runStarted,
      secondDelta,
      textEnd,
      runFinished,
    ]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-1",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const received = await readReplayBurst(response, 6);
    expect(received).toEqual([
      runStarted,
      textStart,
      firstDelta,
      secondDelta,
      textEnd,
      runFinished,
    ]);
  });

  it("drops inter-run side-effect snapshots from live replay", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-before-follow-up",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 2,
        threadId: "thread-1",
        runId: "run-before-follow-up",
      } as BaseEvent,
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 3,
        messages: [
          {
            id: "side-effect-user-follow-up",
            role: "user",
            content: "follow-up prompt",
          },
        ],
      } as BaseEvent,
      {
        type: EventType.RUN_STARTED,
        timestamp: 4,
        threadId: "thread-1",
        runId: "run-after-follow-up",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 5,
        threadId: "thread-1",
        runId: "run-after-follow-up",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-after-follow-up",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const received = await readReplayBurst(response, 2);
    expect(received).toEqual([runEvents[3], runEvents[4]]);
  });

  it("emits the baseline snapshot marker frame before replay deltas", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "chat-1",
        runId: "run-baseline-first",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 2,
        threadId: "chat-1",
        runId: "run-baseline-first",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-baseline-first",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const frames = await readFirstSseFrames(response, 2);
    expect(frames[0]).toEqual({
      comment: "baseline-snapshot",
      id: null,
      event: null,
    });
    expect(frames[1]?.event).toMatchObject({
      type: EventType.RUN_STARTED,
      runId: "run-baseline-first",
    });
  });

  it("scopes fresh run replay to the resolved run", async () => {
    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-a",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 2,
        threadId: "thread-1",
        runId: "run-a",
      } as BaseEvent,
      {
        type: EventType.RUN_STARTED,
        timestamp: 3,
        threadId: "thread-1",
        runId: "run-b",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(events);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue(
      makeRunContext({ runId: "run-b", status: "processing" }),
    );

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-b",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    expect(getAgUiEventEnvelopesForRun).toHaveBeenCalledWith({
      db: dbMocks.db,
      runId: "run-b",
      threadChatId: "chat-1",
    });

    const received = await readReplayBurst(response, 1);
    expect(received).toEqual([events[2]]);
  });

  it("uses fromSeq as a thread-chat cursor across run boundaries", async () => {
    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-a",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 2,
        threadId: "thread-1",
        runId: "run-a",
      } as BaseEvent,
      {
        type: EventType.RUN_STARTED,
        timestamp: 3,
        threadId: "thread-1",
        runId: "run-b",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(events);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue(
      makeRunContext({ runId: "run-b", status: "processing" }),
    );

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-b&fromSeq=1",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    expect(getAgUiEventEnvelopesForThreadChat).toHaveBeenCalledWith({
      db: dbMocks.db,
      threadChatId: "chat-1",
      afterSeq: 1,
    });

    const frames = await readFirstSseFrames(response, 2);
    expect(frames[1]).toMatchObject({
      id: "2",
      event: { type: EventType.RUN_STARTED, runId: "run-b" },
    });
  });

  it("resumes mid-expanded canonical row using the projection cursor", async () => {
    const events: Array<
      BaseEvent & { projectionIndex?: number; projectionCount?: number }
    > = [
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 1,
        messageId: "assistant-1",
        role: "assistant",
        projectionIndex: 0,
        projectionCount: 3,
      } as BaseEvent & { projectionIndex: number; projectionCount: number },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 2,
        messageId: "assistant-1",
        delta: "partial",
        projectionIndex: 1,
        projectionCount: 3,
      } as BaseEvent & { projectionIndex: number; projectionCount: number },
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: 3,
        messageId: "assistant-1",
        projectionIndex: 2,
        projectionCount: 3,
      } as BaseEvent & { projectionIndex: number; projectionCount: number },
      {
        type: EventType.RUN_FINISHED,
        timestamp: 4,
        threadId: "thread-1",
        runId: "run-1",
      } as BaseEvent,
    ];
    const envelopes = events.map((payload, index) => ({
      eventId: index < 3 ? "canonical-message-row" : "event-8",
      seq: index < 3 ? 7 : 8,
      projectionIndex: payload.projectionIndex,
      projectionCount: payload.projectionCount,
      runId: "run-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      timestamp: String(index + 1),
      idempotencyKey: `event-${index}`,
      payload,
    }));
    vi.mocked(getAgUiEventEnvelopesForThreadChat).mockImplementation(
      async ({ afterSeq }) =>
        envelopes.filter(
          (entry) => afterSeq === undefined || entry.seq > afterSeq,
        ),
    );
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue(
      makeRunContext({ runId: "run-1", status: "processing" }),
    );

    const response = await GET(
      makeRequestWithHeaders(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-1",
        { "Last-Event-ID": "7:0" },
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    expect(getAgUiEventEnvelopesForThreadChat).toHaveBeenCalledWith({
      db: dbMocks.db,
      threadChatId: "chat-1",
      afterSeq: 6,
    });
    const frames = await readFirstSseFrames(response, 4);
    expect(frames.map((frame) => frame.id)).toEqual([null, "7:1", "7:2", "8"]);
    expect(frames.map((frame) => frame.event?.type ?? frame.comment)).toEqual([
      "baseline-snapshot",
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });

  it("replays only events after fromSeq and uses seq as the SSE id", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-from-seq",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 2,
        messageId: "msg-from-seq",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 3,
        threadId: "thread-1",
        runId: "run-from-seq",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-from-seq&fromSeq=1",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const frames = await readFirstSseFrames(response, 2);
    expect(frames[1]).toMatchObject({
      id: "2",
      event: { type: EventType.RUN_FINISHED, runId: "run-from-seq" },
    });
  });

  it("uses bare fromSeq as thread-chat catch-up without guessing latest run", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-cursor-only",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: 2,
        messageId: "msg-cursor-only",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 3,
        threadId: "thread-1",
        runId: "run-cursor-only",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=1",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    expect(getLatestRunIdForThreadChat).not.toHaveBeenCalled();

    const frames = await readFirstSseFrames(response, 2);
    expect(frames[1]).toMatchObject({
      id: "2",
      event: { type: EventType.RUN_FINISHED, runId: "run-cursor-only" },
    });
  });

  it("frames POST fromSeq resumes with RUN_STARTED inferred from the first replay entry", async () => {
    const replayEvents: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 1,
        messageId: "msg-resume",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 2,
        messageId: "msg-resume",
        delta: "resume text",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(replayEvents, [11, 12]);

    const response = await POST(
      new NextRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=10",
        { method: "POST" },
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    expect(getLatestRunIdForThreadChat).not.toHaveBeenCalled();

    const received = await readReplayBurst(response, 3);
    expect(received).toEqual([
      {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "run-1",
      },
      ...replayEvents,
    ]);
  });

  it("terminates a synthetic POST resume frame before replaying the next run", async () => {
    const replayEvents: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 1,
        messageId: "msg-run-a",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.RUN_STARTED,
        timestamp: 2,
        threadId: "thread-1",
        runId: "run-b",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 3,
        messageId: "msg-run-b",
        role: "assistant",
      } as BaseEvent,
    ];
    vi.mocked(getAgUiEventEnvelopesForThreadChat).mockResolvedValue([
      {
        eventId: "event-run-a-text-start",
        seq: 11,
        runId: "run-a",
        threadId: "thread-1",
        threadChatId: "chat-1",
        timestamp: "1",
        idempotencyKey: "event-run-a-text-start",
        payload: replayEvents[0]!,
      },
      {
        eventId: "event-run-b-start",
        seq: 12,
        runId: "run-b",
        threadId: "thread-1",
        threadChatId: "chat-1",
        timestamp: "2",
        idempotencyKey: "event-run-b-start",
        payload: replayEvents[1]!,
      },
      {
        eventId: "event-run-b-text-start",
        seq: 13,
        runId: "run-b",
        threadId: "thread-1",
        threadChatId: "chat-1",
        timestamp: "3",
        idempotencyKey: "event-run-b-text-start",
        payload: replayEvents[2]!,
      },
    ]);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=10",
        { method: "POST" },
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const received = await readReplayBurst(response, 3);
    expect(received).toEqual([
      {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "run-a",
      },
      replayEvents[0],
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread-1",
        runId: "run-a",
      },
    ]);
  });

  it("does not frame POST fromSeq resumes around leading history snapshots", async () => {
    const replayEvents: BaseEvent[] = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 1,
        runId: "pre-run:chat-1:follow-up-user-prompt",
        messages: [
          {
            id: "user-follow-up",
            role: "user",
            content: "follow-up",
          },
        ],
      } as BaseEvent,
      {
        type: EventType.RUN_STARTED,
        timestamp: 2,
        threadId: "thread-1",
        runId: "run-follow-up",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 3,
        messageId: "msg-follow-up",
        role: "assistant",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(replayEvents, [11, 12, 13]);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=10",
        { method: "POST" },
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    expect(getLatestRunIdForThreadChat).not.toHaveBeenCalled();

    const received = await readReplayBurst(response, 2);
    expect(received).toEqual([replayEvents[1], replayEvents[2]]);
  });

  it("frames POST fromSeq live-tail after history-only snapshots", async () => {
    const historySnapshot = {
      type: EventType.MESSAGES_SNAPSHOT,
      timestamp: 1,
      runId: "pre-run:chat-1:follow-up-user-prompt",
      messages: [
        {
          id: "user-follow-up",
          role: "user",
          content: "queued follow-up",
        },
      ],
    } as BaseEvent;
    mockAgUiEventEnvelopesForThreadChat([historySnapshot], [11]);

    redisMocks.xread.mockResolvedValueOnce([
      [
        "agui:thread:chat-1",
        [
          [
            "1700000000000-0",
            [
              "envelope",
              JSON.stringify({
                eventId: "event-live-text-start",
                seq: 12,
                runId: "run-live",
                threadId: "thread-1",
                threadChatId: "chat-1",
                timestamp: "2026-04-29T00:00:00.000Z",
                idempotencyKey: "run-live:event-live-text-start",
                payload: {
                  type: EventType.TEXT_MESSAGE_START,
                  timestamp: 2,
                  messageId: "msg-live",
                  role: "assistant",
                },
              }),
            ],
          ],
        ],
      ],
    ]);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&fromSeq=10",
        { method: "POST" },
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const received = await readReplayBurst(response, 2);
    expect(received).toEqual([
      {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "run-live",
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 2,
        messageId: "msg-live",
        role: "assistant",
      },
    ]);
  });

  it("uses Last-Event-ID as a reconnect cursor when fromSeq is absent", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-last-event-id",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 2,
        messageId: "msg-last-event-id",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 3,
        threadId: "thread-1",
        runId: "run-last-event-id",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents);

    const response = await GET(
      makeRequestWithHeaders(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-last-event-id",
        { "Last-Event-ID": "0" },
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const frames = await readFirstSseFrames(response, 3);
    expect(frames[1]).toMatchObject({
      id: "1",
      event: {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-last-event-id",
      },
    });
    expect(frames[2]).toMatchObject({
      id: "2",
      event: { type: EventType.RUN_FINISHED, runId: "run-last-event-id" },
    });
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
    mockAgUiEventEnvelopesForThreadChat(runEvents);
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
    mockAgUiEventEnvelopesForThreadChat(runEvents);

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

  it("does not replay message snapshots after a terminal run event", async () => {
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
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: 3,
        messages: [
          {
            id: "user-duplicate",
            role: "user",
            content: "queued after terminal",
          },
        ],
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-done",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const received = await readReplayBurst(response, 2);
    expect(received).toEqual([runEvents[0], runEvents[1]]);
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
    mockAgUiEventEnvelopesForThreadChat(runEvents);
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
    mockAgUiEventEnvelopesForThreadChat(runEvents);
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
    mockAgUiEventEnvelopesForThreadChat(runEvents);
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

  it("replays durable END rows before terminal fallback when live-tail is idle", async () => {
    const initialEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-terminal-catchup",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 2,
        messageId: "message-open",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 3,
        messageId: "message-open",
        delta: "hello",
      } as BaseEvent,
    ];
    const terminalEvents: BaseEvent[] = [
      ...initialEvents,
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: 4,
        messageId: "message-open",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 5,
        threadId: "thread-1",
        runId: "run-terminal-catchup",
      } as BaseEvent,
    ];
    const envelopes = terminalEvents.map((payload, seq) => ({
      eventId: `event-${seq}`,
      seq,
      runId: "run-terminal-catchup",
      threadId: "thread-1",
      threadChatId: "chat-1",
      timestamp: String(seq + 1),
      idempotencyKey: `event-${seq}`,
      payload,
    }));
    vi.mocked(getAgUiEventEnvelopesForThreadChat).mockImplementation(
      async ({ afterSeq }) => {
        const visibleEnvelopes =
          afterSeq === undefined ? envelopes.slice(0, 3) : envelopes;
        return visibleEnvelopes.filter(
          (entry) => afterSeq === undefined || entry.seq > afterSeq,
        );
      },
    );
    vi.mocked(getAgUiEventEnvelopesForRun).mockImplementation(
      async ({ runId }) =>
        runId === "run-terminal-catchup" ? envelopes.slice(0, 3) : [],
    );
    vi.mocked(getAgentRunContextByRunId)
      .mockResolvedValueOnce(
        makeRunContext({ runId: "run-terminal-catchup", status: "processing" }),
      )
      .mockResolvedValueOnce(
        makeRunContext({ runId: "run-terminal-catchup", status: "completed" }),
      );

    redisMocks.xread.mockResolvedValue(null);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-terminal-catchup",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const events = await readReplayBurst(response, 5);

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
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
    mockAgUiEventEnvelopesForThreadChat(runEvents);
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

  it("dedupes overlapping replay + live-tail events on connect", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-dedupe",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 2,
        messageId: "msg-dedupe",
        role: "assistant",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue(
      makeRunContext({ runId: "run-dedupe", status: "processing" }),
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
                type: EventType.TEXT_MESSAGE_START,
                timestamp: 2,
                messageId: "msg-dedupe",
                role: "assistant",
              }),
            ],
          ],
          [
            "1700000000001-0",
            [
              "event",
              JSON.stringify({
                type: EventType.RUN_FINISHED,
                timestamp: 3,
                threadId: "thread-1",
                runId: "run-dedupe",
              }),
            ],
          ],
        ],
      ],
    ]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-dedupe",
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

    const textStartCount = events.filter(
      (event) => event.type === EventType.TEXT_MESSAGE_START,
    ).length;
    expect(textStartCount).toBe(1);
    expect(events).toMatchObject([
      { type: EventType.RUN_STARTED, runId: "run-dedupe" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg-dedupe" },
      { type: EventType.RUN_FINISHED, runId: "run-dedupe" },
    ]);
  });

  it("does not re-emit live-tail entries at or before the reconnect cursor", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-reconnect",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 2,
        messageId: "msg-reconnect",
        role: "assistant",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue(
      makeRunContext({ runId: "run-reconnect", status: "processing" }),
    );

    redisMocks.xread.mockResolvedValueOnce([
      [
        "agui:thread:chat-1",
        [
          [
            "1700000000001-0",
            [
              "envelope",
              JSON.stringify({
                eventId: "event-reconnect-text",
                seq: 1,
                runId: "run-reconnect",
                threadId: "thread-1",
                threadChatId: "chat-1",
                timestamp: "2026-04-27T00:00:01.000Z",
                idempotencyKey: "run-reconnect:event-reconnect-text",
                payload: {
                  type: EventType.TEXT_MESSAGE_START,
                  timestamp: 2,
                  messageId: "msg-reconnect",
                  role: "assistant",
                },
              }),
            ],
          ],
          [
            "1700000000002-0",
            [
              "envelope",
              JSON.stringify({
                eventId: "event-reconnect-finished",
                seq: 2,
                runId: "run-reconnect",
                threadId: "thread-1",
                threadChatId: "chat-1",
                timestamp: "2026-04-27T00:00:02.000Z",
                idempotencyKey: "run-reconnect:event-reconnect-finished",
                payload: {
                  type: EventType.RUN_FINISHED,
                  timestamp: 3,
                  threadId: "thread-1",
                  runId: "run-reconnect",
                },
              }),
            ],
          ],
        ],
      ],
    ]);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-reconnect&fromSeq=1",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);

    const frames = await readFirstSseFrames(response, 2);
    expect(frames[1]).toMatchObject({
      id: "2",
      event: { type: EventType.RUN_FINISHED, runId: "run-reconnect" },
    });
  });

  it("emits RUN_FINISHED and closes when XREAD throws and durable status flips terminal", async () => {
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-xread-error-terminal",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents);
    vi.mocked(getAgentRunContextByRunId)
      .mockResolvedValueOnce(
        makeRunContext({
          runId: "run-xread-error-terminal",
          status: "processing",
        }),
      )
      .mockResolvedValueOnce(
        makeRunContext({
          runId: "run-xread-error-terminal",
          status: "completed",
        }),
      );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    redisMocks.xread.mockRejectedValue(new Error("redis down"));

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-xread-error-terminal",
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
      { type: EventType.RUN_STARTED, runId: "run-xread-error-terminal" },
      { type: EventType.RUN_FINISHED, runId: "run-xread-error-terminal" },
    ]);
    expect(redisMocks.xread).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("emits RUN_ERROR and closes when the run has no events", async () => {
    mockAgUiEventEnvelopesForThreadChat([]);

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
    mockAgUiEventEnvelopesForThreadChat(malformed);
    vi.mocked(getAgUiEventEnvelopesForRun).mockResolvedValue([
      {
        eventId: "event-broken",
        seq: 1,
        runId: "run-broken",
        threadId: "thread-1",
        threadChatId: "chat-1",
        timestamp: "1",
        idempotencyKey: "event-broken",
        payload: malformed[0]!,
      },
    ]);
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

  it("emits RUN_ERROR instead of streaming malformed known AG-UI events", async () => {
    const malformed: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-1",
        runId: "run-malformed-known",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 2,
        delta: "missing message id",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(malformed);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-malformed-known",
      ),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    const received = await readReplayBurst(response, 2);
    expect(received).toMatchObject([
      { type: EventType.RUN_STARTED, runId: "run-malformed-known" },
      { type: EventType.RUN_ERROR, code: "replay_failed" },
    ]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("emits RUN_ERROR when getAgUiEventEnvelopesForRun throws", async () => {
    vi.mocked(getAgUiEventEnvelopesForRun).mockRejectedValue(
      new Error("db exploded"),
    );
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
    vi.mocked(getAgUiEventEnvelopesForRun).mockImplementation(async () => {
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
    mockAgUiEventEnvelopesForThreadChat(runEvents);

    const response = await GET(
      makeRequest("http://localhost/api/ag-ui/thread-1?threadChatId=chat-1"),
      makeContext("thread-1"),
    );
    expect(response.status).toBe(200);
    expect(getLatestRunIdForThreadChat).toHaveBeenCalledWith({
      db: dbMocks.db,
      threadChatId: "chat-1",
    });
    expect(getAgUiEventEnvelopesForRun).toHaveBeenCalledWith({
      db: dbMocks.db,
      runId: "run-latest",
      threadChatId: "chat-1",
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
    mockAgUiEventEnvelopesForThreadChat(runEvents);
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
    expect(getAgUiEventEnvelopesForThreadChat).not.toHaveBeenCalled();
    // Live tail engaged: xread is called to poll for the first real
    // RUN_STARTED written by an incoming daemon-event.
    await vi.waitFor(() => {
      expect(redisMocks.xread).toHaveBeenCalled();
    });
    await response.body!.cancel();
  });

  it("durably catches up when an empty live-tail discovers a run after connect", async () => {
    vi.mocked(getLatestRunIdForThreadChat)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("run-discovered");
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 1,
        threadId: "thread-new",
        runId: "run-discovered",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 2,
        threadId: "thread-new",
        runId: "run-discovered",
      } as BaseEvent,
    ];
    mockAgUiEventEnvelopesForThreadChat(runEvents);
    redisMocks.xread.mockResolvedValue(null);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-new?threadChatId=chat-empty",
      ),
      makeContext("thread-new"),
    );
    expect(response.status).toBe(200);

    const received = await readReplayBurst(response, 2);
    expect(received).toEqual(runEvents);
    expect(getAgUiEventEnvelopesForThreadChat).toHaveBeenCalledWith({
      db: dbMocks.db,
      threadChatId: "chat-empty",
      afterSeq: undefined,
    });
  });

  it("emits the baseline snapshot marker before awaiting-first-run on empty threads", async () => {
    vi.mocked(getLatestRunIdForThreadChat).mockResolvedValue(null);

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-new?threadChatId=chat-empty",
      ),
      makeContext("thread-new"),
    );
    expect(response.status).toBe(200);

    const frames = await readFirstSseFrames(response, 2);
    expect(frames[0]).toEqual({
      comment: "baseline-snapshot",
      id: null,
      event: null,
    });
    expect(frames[1]).toEqual({
      comment: "awaiting-first-run",
      id: null,
      event: null,
    });
  });

  it("replays snapshots after a history cursor even before the first run starts", async () => {
    vi.mocked(getLatestRunIdForThreadChat).mockResolvedValue(null);
    const snapshotEvent = {
      type: EventType.MESSAGES_SNAPSHOT,
      timestamp: 1,
      messages: [
        {
          id: "user-gap",
          role: "user",
          content: "written between history and stream",
        },
      ],
    } as BaseEvent;
    vi.mocked(getAgUiEventEnvelopesForThreadChat).mockImplementation(
      async ({ afterSeq }) =>
        [
          {
            eventId: "event-gap",
            seq: 1,
            runId: "pre-run",
            threadId: "thread-new",
            threadChatId: "chat-empty",
            timestamp: "1",
            idempotencyKey: "event-gap",
            payload: snapshotEvent,
          },
        ].filter((entry) => afterSeq === undefined || entry.seq > afterSeq),
    );

    const response = await GET(
      makeRequest(
        "http://localhost/api/ag-ui/thread-new?threadChatId=chat-empty&fromSeq=-1",
      ),
      makeContext("thread-new"),
    );
    expect(response.status).toBe(200);

    const received = await readReplayBurst(response, 1);
    expect(received).toEqual([snapshotEvent]);
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
    expect(getAgUiEventEnvelopesForThreadChat).not.toHaveBeenCalled();
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

  it("keeps XREAD blockMS pinned in local redis-http mode", async () => {
    redisMocks.isLocalRedisHttpMode.mockReturnValue(true);
    const blockValues: number[] = [];
    const deferred: Array<{ resolve: (v: unknown) => void }> = [];

    redisMocks.xread.mockImplementation((...args: unknown[]) => {
      const opts = args[2] as { blockMS?: number } | undefined;
      blockValues.push(opts?.blockMS ?? -1);
      if (redisMocks.xread.mock.calls.length > 5) {
        return new Promise((resolve) => {
          deferred.push({ resolve });
        });
      }
      return Promise.resolve(null);
    });

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
    expect(blockValues.slice(0, 5)).toEqual([2000, 2000, 2000, 2000, 2000]);

    await response.body!.cancel();
    for (const d of deferred) d.resolve(null);
  });
});
