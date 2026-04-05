import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DBUserMessage } from "@terragon/shared";

const TEST_USER_MESSAGE = {
  type: "user",
  model: null,
  parts: [{ type: "text", text: "follow up" }],
} satisfies DBUserMessage;

async function loadSubject(options: {
  initialThreadChat: Record<string, unknown> | null;
  latestThreadChat?: Record<string, unknown> | null;
  latestRunContextForThreadChat?: Record<string, unknown> | null;
  runContextByRunId?: Record<string, unknown> | null;
  activeDispatchIntent?: Record<string, unknown> | null;
  didUpdateStatus?: boolean;
  slashCommand?: { name: string } | null;
  startAgentMessageResult?: { dispatchLaunched: boolean };
  startAgentMessageError?: Error | null;
  scheduleFollowUpRetryError?: Error | null;
}) {
  const getThreadChat = vi.fn();
  const getThreadMinimal = vi.fn().mockResolvedValue({
    id: "thread-1",
    branchName: "terragon/test-branch",
  });
  getThreadChat.mockResolvedValueOnce(options.initialThreadChat);
  if (options.latestThreadChat !== undefined) {
    getThreadChat.mockResolvedValueOnce(options.latestThreadChat);
  }

  const updateThreadChatWithTransition = vi.fn().mockResolvedValue({
    didUpdateStatus: options.didUpdateStatus ?? true,
    updatedStatus: undefined,
  });
  const startAgentMessage =
    options.startAgentMessageError === undefined ||
    options.startAgentMessageError === null
      ? vi
          .fn()
          .mockResolvedValue(
            options.startAgentMessageResult ?? { dispatchLaunched: true },
          )
      : vi.fn().mockRejectedValue(options.startAgentMessageError);
  const scheduleFollowUpRetryJob =
    options.scheduleFollowUpRetryError === undefined ||
    options.scheduleFollowUpRetryError === null
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(options.scheduleFollowUpRetryError);
  const getSlashCommandOrNull = vi
    .fn()
    .mockReturnValue(options.slashCommand ?? null);

  vi.resetModules();
  vi.doMock("@/lib/db", () => ({
    db: {},
  }));
  vi.doMock("@terragon/shared/model/threads", () => ({
    getThreadChat,
    getThreadMinimal,
  }));
  vi.doMock("@/agent/update-status", () => ({
    updateThreadChatWithTransition,
  }));
  vi.doMock("@/agent/msg/startAgentMessage", () => ({
    startAgentMessage,
  }));
  vi.doMock("@/agent/slash-command-handler", () => ({
    getSlashCommandOrNull,
  }));
  vi.doMock("@/server-lib/delivery-loop/retry-jobs", () => ({
    scheduleFollowUpRetryJob,
  }));
  vi.doMock("@terragon/shared/model/agent-run-context", () => ({
    getAgentRunContextByRunId: vi
      .fn()
      .mockResolvedValue(options.runContextByRunId ?? null),
    getLatestAgentRunContextForThreadChat: vi
      .fn()
      .mockResolvedValue(options.latestRunContextForThreadChat ?? null),
  }));
  vi.doMock(
    "@terragon/shared/delivery-loop/store/dispatch-intent-store",
    () => ({
      getLatestActiveDispatchIntentForThreadChat: vi
        .fn()
        .mockResolvedValue(options.activeDispatchIntent ?? null),
    }),
  );
  vi.doMock("@/lib/db-message-helpers", () => ({
    getLastUserMessageModel: vi.fn(() => null),
  }));
  vi.doMock("@terragon/agent/utils", () => ({
    getDefaultModelForAgent: vi.fn(() => "sonnet"),
  }));

  const subject = await import("./process-follow-up-queue");
  return {
    maybeProcessFollowUpQueue: subject.maybeProcessFollowUpQueue,
    getThreadChat,
    updateThreadChatWithTransition,
    startAgentMessage,
    scheduleFollowUpRetryJob,
  };
}

describe("maybeProcessFollowUpQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not process queued work while chat remains scheduled", async () => {
    const { maybeProcessFollowUpQueue, startAgentMessage } = await loadSubject({
      initialThreadChat: {
        id: "chat-1",
        status: "scheduled",
        queuedMessages: [TEST_USER_MESSAGE],
      },
    });

    const result = await maybeProcessFollowUpQueue({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
    });

    expect(result).toEqual({
      processed: false,
      dispatchLaunched: false,
      reason: "scheduled_not_runnable",
    });
    expect(startAgentMessage).not.toHaveBeenCalled();
  });

  it("does not launch batch follow-up after a failed status transition", async () => {
    const { maybeProcessFollowUpQueue, startAgentMessage } = await loadSubject({
      initialThreadChat: {
        id: "chat-1",
        status: "complete",
        agent: "claudeCode",
        agentVersion: 0,
        queuedMessages: [TEST_USER_MESSAGE],
        messages: [],
      },
      latestThreadChat: {
        id: "chat-1",
        status: "complete",
      },
      didUpdateStatus: false,
    });

    const result = await maybeProcessFollowUpQueue({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
    });

    expect(result).toEqual({
      processed: false,
      dispatchLaunched: false,
      reason: "stale_cas",
    });
    expect(startAgentMessage).not.toHaveBeenCalled();
  });

  it("does not launch slash follow-up after a failed status transition", async () => {
    const { maybeProcessFollowUpQueue, startAgentMessage } = await loadSubject({
      initialThreadChat: {
        id: "chat-1",
        status: "complete",
        agent: "claudeCode",
        agentVersion: 0,
        queuedMessages: [TEST_USER_MESSAGE],
        messages: [],
      },
      latestThreadChat: {
        id: "chat-1",
        status: "complete",
      },
      didUpdateStatus: false,
      slashCommand: { name: "/compact" },
    });

    const result = await maybeProcessFollowUpQueue({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
    });

    expect(result).toEqual({
      processed: false,
      dispatchLaunched: false,
      reason: "stale_cas",
    });
    expect(startAgentMessage).not.toHaveBeenCalled();
  });

  it("treats stale busy CAS as launched when a matching run is active", async () => {
    const { maybeProcessFollowUpQueue, startAgentMessage } = await loadSubject({
      initialThreadChat: {
        id: "chat-1",
        status: "complete",
        agent: "claudeCode",
        agentVersion: 0,
        queuedMessages: [TEST_USER_MESSAGE],
        messages: [],
      },
      latestThreadChat: {
        id: "chat-1",
        status: "booting",
      },
      latestRunContextForThreadChat: {
        runId: "run-1",
        status: "processing",
        updatedAt: new Date(),
      },
      didUpdateStatus: false,
    });

    const result = await maybeProcessFollowUpQueue({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
    });

    expect(result).toEqual({
      processed: false,
      dispatchLaunched: true,
      reason: "stale_cas_busy",
    });
    expect(startAgentMessage).not.toHaveBeenCalled();
  });

  it("returns dispatch_not_started when startAgentMessage does not launch a run", async () => {
    const { maybeProcessFollowUpQueue, startAgentMessage } = await loadSubject({
      initialThreadChat: {
        id: "chat-1",
        status: "complete",
        agent: "claudeCode",
        agentVersion: 0,
        queuedMessages: [TEST_USER_MESSAGE],
        messages: [],
      },
      startAgentMessageResult: { dispatchLaunched: false },
    });

    const result = await maybeProcessFollowUpQueue({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
    });

    expect(startAgentMessage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      processed: false,
      dispatchLaunched: false,
      reason: "dispatch_not_started",
    });
  });

  it("launches delivery-loop work from dispatch intent without queued messages", async () => {
    const { maybeProcessFollowUpQueue, startAgentMessage } = await loadSubject({
      initialThreadChat: {
        id: "chat-1",
        status: "complete",
        agent: "claudeCode",
        agentVersion: 0,
        queuedMessages: [],
        messages: [],
      },
      activeDispatchIntent: {
        targetPhase: "implementing",
      },
    });

    const result = await maybeProcessFollowUpQueue({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
    });

    expect(startAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        db: {},
        userId: "user-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
        isNewThread: false,
        createNewBranch: false,
        branchName: "terragon/test-branch",
      }),
    );
    expect(result).toEqual({
      processed: true,
      dispatchLaunched: true,
      reason: "dispatch_started_batch",
    });
  });

  it("schedules retry when runId is provided but run context is not terminal", async () => {
    const { maybeProcessFollowUpQueue, scheduleFollowUpRetryJob } =
      await loadSubject({
        initialThreadChat: {
          id: "chat-1",
          status: "complete",
          agent: "claudeCode",
          agentVersion: 0,
          queuedMessages: [TEST_USER_MESSAGE],
          messages: [],
        },
        runContextByRunId: {
          runId: "run-1",
          threadId: "thread-1",
          threadChatId: "chat-1",
          status: "processing",
        },
      });

    const result = await maybeProcessFollowUpQueue({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      runId: "run-1",
    });

    expect(result).toEqual({
      processed: false,
      dispatchLaunched: false,
      reason: "dispatch_retry_scheduled",
      retryCount: 1,
      maxRetries: 3,
    });
    expect(scheduleFollowUpRetryJob).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
        dispatchAttempt: 1,
        deferCount: 0,
        runAt: expect.any(Date),
      }),
    );
  });

  it("schedules a durable retry job when dispatch fails", async () => {
    const { maybeProcessFollowUpQueue, scheduleFollowUpRetryJob } =
      await loadSubject({
        initialThreadChat: {
          id: "chat-1",
          status: "complete",
          agent: "claudeCode",
          agentVersion: 0,
          queuedMessages: [TEST_USER_MESSAGE],
          messages: [],
        },
        startAgentMessageError: new Error("boom"),
      });

    const result = await maybeProcessFollowUpQueue({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
    });

    expect(result.processed).toBe(false);
    expect(result.dispatchLaunched).toBe(false);
    expect(result.reason).toBe("dispatch_retry_scheduled");
    expect(scheduleFollowUpRetryJob).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
        dispatchAttempt: 1,
        deferCount: 0,
        runAt: expect.any(Date),
      }),
    );
  });

  it("recovers durable retry persistence failure through owner fallback", async () => {
    const { maybeProcessFollowUpQueue, scheduleFollowUpRetryJob } =
      await loadSubject({
        initialThreadChat: {
          id: "chat-1",
          status: "complete",
          agent: "claudeCode",
          agentVersion: 0,
          queuedMessages: [TEST_USER_MESSAGE],
          messages: [],
        },
        startAgentMessageError: new Error("boom"),
      });

    scheduleFollowUpRetryJob.mockRejectedValueOnce(
      new Error("redis unavailable"),
    );

    const result = await maybeProcessFollowUpQueue({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
    });

    expect(result).toEqual({
      processed: false,
      dispatchLaunched: false,
      reason: "dispatch_retry_scheduled",
      retryCount: 1,
      maxRetries: 3,
    });
    expect(scheduleFollowUpRetryJob).toHaveBeenCalledTimes(2);
  });

  it("returns explicit outcome when durable retry persistence fails after fallback ownership", async () => {
    const { maybeProcessFollowUpQueue, scheduleFollowUpRetryJob } =
      await loadSubject({
        initialThreadChat: {
          id: "chat-1",
          status: "complete",
          agent: "claudeCode",
          agentVersion: 0,
          queuedMessages: [TEST_USER_MESSAGE],
          messages: [],
        },
        startAgentMessageError: new Error("boom"),
        scheduleFollowUpRetryError: new Error("redis unavailable"),
      });

    const result = await maybeProcessFollowUpQueue({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
    });

    expect(result).toEqual({
      processed: false,
      dispatchLaunched: false,
      reason: "dispatch_retry_persistence_failed",
      retryCount: 1,
      maxRetries: 3,
    });
    expect(scheduleFollowUpRetryJob).toHaveBeenCalledTimes(2);
  });
});
