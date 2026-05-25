/* @vitest-environment jsdom */

import { type BaseEvent, EventType } from "@ag-ui/core";
import {
  getAgUiEventEnvelopesForRun,
  getAgUiEventEnvelopesForThreadChat,
  getLatestRunIdForThreadChat,
} from "@terragon/shared/model/agent-event-log";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionOrNull } from "@/lib/auth-server";
import type { AgentTraceSpan } from "@/lib/agent-trace";
import { dispatchFollowUpFromAppend } from "@/server-lib/follow-up-command";
import { POST } from "../../src/app/api/ag-ui/[threadId]/route";
import { replayAgUi } from "./ag-ui-replayer";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const dbMocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));
  return {
    limit,
    db: { select },
  };
});

const redisMocks = vi.hoisted(() => {
  const xread = vi.fn<(...args: unknown[]) => Promise<unknown>>(
    () => new Promise(() => {}),
  );
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

vi.mock("@/server-lib/follow-up-command", () => ({
  dispatchFollowUpFromAppend: vi.fn(),
}));

async function readReplayBurst(
  response: Response,
  expectedEventCount: number,
): Promise<BaseEvent[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const events: BaseEvent[] = [];
  const timeout = setTimeout(() => reader.cancel("test-timeout"), 1_000);
  try {
    while (events.length < expectedEventCount) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame
          .split("\n")
          .find((item) => item.startsWith("data: "));
        if (!line) continue;
        events.push(JSON.parse(line.slice("data: ".length)) as BaseEvent);
        if (events.length >= expectedEventCount) break;
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

function makePostRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function mockAgUiEventEnvelopesForThreadChat(params: {
  events: BaseEvent[];
  runId: string;
}): void {
  const envelopes = params.events.map((payload, index) => ({
    eventId: `trace-event-${index}`,
    seq: index,
    projectionIndex: index,
    projectionCount: params.events.length,
    runId: params.runId,
    threadId: "thread-1",
    threadChatId: "chat-1",
    timestamp: String(index + 1),
    idempotencyKey: `${params.runId}:trace-event-${index}`,
    payload,
  }));
  vi.mocked(getAgUiEventEnvelopesForThreadChat).mockImplementation(
    async ({ afterSeq }) => {
      return envelopes.filter(
        (entry) => afterSeq === undefined || entry.seq > afterSeq,
      );
    },
  );
  vi.mocked(getAgUiEventEnvelopesForRun).mockImplementation(
    async ({ runId, threadChatId }) => {
      return envelopes.filter(
        (entry) =>
          entry.runId === runId &&
          (threadChatId === undefined || entry.threadChatId === threadChatId),
      );
    },
  );
}

describe("prompt to daemon to client trace", () => {
  const traceSpans: AgentTraceSpan[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    traceSpans.length = 0;
    globalThis.__terragonAgentTraceSink = (span) => {
      traceSpans.push(span);
    };
    dbMocks.limit.mockResolvedValue([
      { id: "chat-1", messages: [], threadName: null },
    ]);
    redisMocks.xread.mockImplementation(() => new Promise(() => {}));
    redisMocks.xrevrange.mockImplementation(() => Promise.resolve({}));
    redisMocks.isLocalRedisHttpMode.mockReturnValue(false);
    vi.mocked(getLatestRunIdForThreadChat).mockResolvedValue(null);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue(null);
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
  });

  afterEach(() => {
    globalThis.__terragonAgentTraceSink = undefined;
  });

  it("correlates one prompt through AG-UI POST, daemon events, SSE replay, and client render", async () => {
    const runId = "run-trace-1";
    const traceId = runId;
    const prompt = "Summarize the streaming trace path";
    const assistantText = `trace ${traceId}: daemon streamed the first visible answer`;
    const daemonEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        timestamp: 10,
        threadId: "thread-1",
        runId,
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: 11,
        messageId: "assistant-trace-1",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 12,
        messageId: "assistant-trace-1",
        delta: assistantText,
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: 13,
        messageId: "assistant-trace-1",
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: 14,
        threadId: "thread-1",
        runId,
      } as BaseEvent,
    ];

    mockAgUiEventEnvelopesForThreadChat({
      events: daemonEvents,
      runId,
    });
    vi.mocked(getLatestRunIdForThreadChat).mockResolvedValue(runId);
    vi.mocked(dispatchFollowUpFromAppend).mockImplementation(async () => {
      return { runId };
    });

    const response = await POST(
      makePostRequest(
        "http://localhost/api/ag-ui/thread-1?threadChatId=chat-1&runId=run-trace-1",
        {
          threadId: "thread-1",
          runId,
          messages: [{ id: "user-trace-1", role: "user", content: prompt }],
          tools: [],
          context: [],
          forwardedProps: {
            runConfig: {
              terragon: {
                intent: "append",
                traceId,
              },
            },
          },
        },
      ),
      makeContext("thread-1"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(dispatchFollowUpFromAppend).toHaveBeenCalledWith({
      threadId: "thread-1",
      threadChatId: "chat-1",
      userId: "user-1",
      body: expect.objectContaining({
        messages: [{ id: "user-trace-1", role: "user", content: prompt }],
      }),
      isReplayMode: false,
    });

    const receivedEvents = await readReplayBurst(response, daemonEvents.length);
    expect(receivedEvents).toEqual(daemonEvents);

    const { messages, lifecycle, quarantine } =
      await replayAgUi(receivedEvents);

    expect(quarantine).toEqual([]);
    expect(lifecycle).toMatchObject({
      runId,
      runStarted: false,
      threadStatus: "complete",
    });
    expect(messages).toEqual([]);

    const spanNames = traceSpans.map((span) => span.name);
    expect(spanNames).toEqual(
      expect.arrayContaining([
        "server.agui.post.received",
        "server.agui.followup.dispatched",
        "server.agui.sse.opened",
        "server.agui.sse.first_frame",
        "server.agui.sse.closed",
        "client.agui.event.received",
        "client.ui.projected",
      ]),
    );
    expect(
      traceSpans.some(
        (span) =>
          span.name === "client.agui.event.received" &&
          span.attributes["eventType"] === EventType.RUN_FINISHED,
      ),
    ).toBe(true);
    expect(indexOfSpan("server.agui.post.received")).toBeLessThan(
      indexOfSpan("server.agui.followup.dispatched"),
    );
    expect(indexOfSpan("server.agui.sse.opened")).toBeLessThan(
      indexOfSpan("server.agui.sse.first_frame"),
    );
    expect(indexOfSpan("server.agui.sse.first_frame")).toBeLessThan(
      indexOfSpan("server.agui.sse.closed"),
    );
    expect(indexOfSpan("client.agui.event.received")).toBeLessThan(
      indexOfSpan("client.ui.projected"),
    );
    for (const span of traceSpans) {
      if (
        span.name === "client.agui.event.received" &&
        typeof span.attributes["messageId"] === "string"
      ) {
        expect(span.traceId).toBe(span.attributes["messageId"]);
      } else {
        expect(span.traceId).toBe(traceId);
      }
      expect(span.endedAtMs).toBeGreaterThanOrEqual(span.startedAtMs);
    }

    function indexOfSpan(name: AgentTraceSpan["name"]): number {
      const index = spanNames.indexOf(name);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    }
  });
});
