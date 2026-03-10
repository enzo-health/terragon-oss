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
  didUpdateStatus?: boolean;
  slashCommand?: { name: string } | null;
  startAgentMessageError?: Error | null;
}) {
  const getThreadChat = vi.fn();
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
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(options.startAgentMessageError);
  const scheduleFollowUpRetryJob = vi.fn().mockResolvedValue(undefined);
  const getSlashCommandOrNull = vi
    .fn()
    .mockReturnValue(options.slashCommand ?? null);

  vi.resetModules();
  vi.doMock("@/lib/db", () => ({
    db: {},
  }));
  vi.doMock("@terragon/shared/model/threads", () => ({
    getThreadChat,
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
    getAgentRunContextByRunId: vi.fn().mockResolvedValue(null),
  }));
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
      reason: "stale_cas",
    });
    expect(startAgentMessage).not.toHaveBeenCalled();
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
});
