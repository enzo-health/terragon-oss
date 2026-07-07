import { EventType, type BaseEvent } from "@ag-ui/core";
import type { AgUiEventEnvelope } from "@terragon/shared/model/agent-event-log";
import {
  getAgUiEventEnvelopesForThreadChat,
  getLatestRunIdForThreadChat,
} from "@terragon/shared/model/agent-event-log";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRunTerminalAgUi } from "@/server-lib/ag-ui-publisher";
import {
  discoverRunFromDurableLog,
  reconcileActiveRunFromDurable,
  replayDurableEventsAfterCursor,
  type LiveTailSseSession,
} from "./thread-event-live-tail";

vi.mock("@terragon/shared/model/agent-event-log", () => ({
  getAgUiEventEnvelopesForThreadChat: vi.fn(),
  getLatestRunIdForThreadChat: vi.fn(),
  isTerminalAgentRunStatus: (status: string) =>
    status === "completed" || status === "failed" || status === "stopped",
}));

vi.mock("@terragon/shared/model/agent-run-context", () => ({
  getAgentRunContextByRunId: vi.fn(),
}));

vi.mock("@/server-lib/ag-ui-publisher", () => ({
  buildRunTerminalAgUi: vi.fn(
    (params: { threadId: string; runId: string; daemonRunStatus: string }) =>
      ({
        type:
          params.daemonRunStatus === "failed"
            ? EventType.RUN_ERROR
            : EventType.RUN_FINISHED,
        threadId: params.threadId,
        runId: params.runId,
      }) as BaseEvent,
  ),
}));

function makeEnvelope(
  seq: number,
  payload: BaseEvent,
): AgUiEventEnvelope<BaseEvent, "full"> {
  return {
    eventId: `event-${seq}`,
    seq,
    runId: "run-1",
    threadId: "thread-1",
    threadChatId: "chat-1",
    timestamp: "2026-05-31T00:00:00.000Z",
    idempotencyKey: `run-1:event-${seq}`,
    payload,
  };
}

function makeSse(
  overrides: Partial<LiveTailSseSession> = {},
): LiveTailSseSession {
  let closed = false;
  const sse: LiveTailSseSession = {
    get closed() {
      return closed;
    },
    hasEmittedAgUiDataEvent: false,
    lastDeliveredSeq: null,
    replayCursorSeq: null,
    resolvedRunId: "run-1",
    frameResumeReplayEntries: vi.fn(() => true),
    emitReplayEntry: vi.fn(() => true),
    emitAgUiEvent: vi.fn(() => true),
    close: vi.fn((reason) => {
      closed = true;
      void reason;
    }),
    ...overrides,
  };
  return sse;
}

describe("thread event live tail helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replays durable events after the last delivered cursor and closes on terminal", async () => {
    const sse = makeSse({ lastDeliveredSeq: 4 });
    vi.mocked(getAgUiEventEnvelopesForThreadChat).mockResolvedValue([
      makeEnvelope(5, {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-1",
        delta: "done",
      } as BaseEvent),
      makeEnvelope(6, {
        type: EventType.RUN_FINISHED,
        threadId: "thread-1",
        runId: "run-1",
      } as BaseEvent),
    ]);

    await expect(
      replayDurableEventsAfterCursor({
        db: {} as never,
        sse,
        threadId: "thread-1",
        threadChatId: "chat-1",
      }),
    ).resolves.toBe(true);

    expect(getAgUiEventEnvelopesForThreadChat).toHaveBeenCalledWith({
      db: {},
      threadChatId: "chat-1",
      afterSeq: 4,
    });
    expect(sse.emitReplayEntry).toHaveBeenCalledTimes(3);
    const firstEmitted = vi.mocked(sse.emitReplayEntry).mock.calls[0]![0];
    expect(firstEmitted.event.type).toBe(EventType.TEXT_MESSAGE_START);
    expect(Reflect.get(firstEmitted.event, "messageId")).toBe("message-1");
    expect(sse.close).toHaveBeenCalledWith("terminal_event");
  });

  it("emits a terminal fallback when the run context is terminal but no durable terminal was replayed", async () => {
    const sse = makeSse();
    vi.mocked(getAgUiEventEnvelopesForThreadChat).mockResolvedValue([]);
    vi.mocked(getAgentRunContextByRunId).mockResolvedValue({
      status: "completed",
      failureTerminalReason: null,
      failureCategory: null,
    } as Awaited<ReturnType<typeof getAgentRunContextByRunId>>);

    await expect(
      reconcileActiveRunFromDurable({
        db: {} as never,
        sse,
        threadId: "thread-1",
        threadChatId: "chat-1",
        runId: "run-1",
        userId: "user-1",
        phase: "idle",
      }),
    ).resolves.toBe(true);

    expect(buildRunTerminalAgUi).toHaveBeenCalledWith({
      threadId: "thread-1",
      runId: "run-1",
      daemonRunStatus: "completed",
      errorMessage: null,
      errorCode: null,
    });
    expect(sse.emitAgUiEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: EventType.RUN_FINISHED }),
      null,
    );
    expect(sse.close).toHaveBeenCalledWith("durable_terminal_idle");
  });

  it("discovers the latest run from the durable log and replays catch-up events", async () => {
    const sse = makeSse({ resolvedRunId: null });
    vi.mocked(getLatestRunIdForThreadChat).mockResolvedValue("run-latest");
    vi.mocked(getAgUiEventEnvelopesForThreadChat).mockResolvedValue([
      makeEnvelope(2, {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "run-latest",
      } as BaseEvent),
    ]);

    await expect(
      discoverRunFromDurableLog({
        db: {} as never,
        sse,
        threadId: "thread-1",
        threadChatId: "chat-1",
      }),
    ).resolves.toEqual({ discoveredRunId: "run-latest", replayed: true });

    expect(getLatestRunIdForThreadChat).toHaveBeenCalledWith({
      db: {},
      threadChatId: "chat-1",
    });
    expect(sse.resolvedRunId).toBe("run-latest");
    expect(sse.emitReplayEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ type: EventType.RUN_STARTED }),
      }),
    );
  });

  it("does not mutate the live-tail session when no durable run exists", async () => {
    const sse = makeSse({ resolvedRunId: null });
    vi.mocked(getLatestRunIdForThreadChat).mockResolvedValue(null);

    await expect(
      discoverRunFromDurableLog({
        db: {} as never,
        sse,
        threadId: "thread-1",
        threadChatId: "chat-1",
      }),
    ).resolves.toEqual({ discoveredRunId: null, replayed: false });

    expect(sse.resolvedRunId).toBeNull();
    expect(getAgUiEventEnvelopesForThreadChat).not.toHaveBeenCalled();
  });
});
