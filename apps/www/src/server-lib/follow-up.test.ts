import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DBUserMessage } from "@terragon/shared";

const threadMocks = vi.hoisted(() => ({
  getThreadChat: vi.fn(),
  getThreadMinimal: vi.fn(),
  updateThreadChat: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
  maybeProcessFollowUpQueue: vi.fn(),
}));

const transitionMocks = vi.hoisted(() => ({
  updateThreadChatWithTransition: vi.fn(),
}));

const agentDispatchMocks = vi.hoisted(() => ({
  dispatchAgentMessage: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {},
}));

vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({
    capture: vi.fn(),
  }),
}));

vi.mock("@terragon/shared/model/threads", () => ({
  getThreadChat: threadMocks.getThreadChat,
  getThreadMinimal: threadMocks.getThreadMinimal,
  updateThreadChat: threadMocks.updateThreadChat,
}));

vi.mock("./process-follow-up-queue", () => ({
  maybeProcessFollowUpQueue: queueMocks.maybeProcessFollowUpQueue,
  ensureDispatchRetryPersistenceOwnership: vi.fn(({ result }) => result),
}));

vi.mock("@/agent/update-status", () => ({
  updateThreadChatWithTransition:
    transitionMocks.updateThreadChatWithTransition,
}));

vi.mock("@/agent/msg/startAgentMessage", () => ({
  dispatchAgentMessage: agentDispatchMocks.dispatchAgentMessage,
}));

vi.mock("@/lib/r2-file-upload-server", () => ({
  uploadUserMessageImages: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

import { followUpInternal, queueFollowUpInternal } from "./follow-up";

const TEST_USER_MESSAGE = {
  type: "user",
  model: null,
  parts: [{ type: "text", text: "follow up" }],
} satisfies DBUserMessage;

describe("queueFollowUpInternal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threadMocks.updateThreadChat.mockResolvedValue(undefined);
    threadMocks.getThreadMinimal.mockResolvedValue({
      id: "thread-1",
      codesandboxId: "sandbox-1",
    });
    queueMocks.maybeProcessFollowUpQueue.mockResolvedValue({
      processed: false,
      dispatchLaunched: false,
      reason: "no_queued_messages",
    });
    transitionMocks.updateThreadChatWithTransition.mockResolvedValue({
      didUpdateStatus: true,
      updatedStatus: "queued",
    });
    agentDispatchMocks.dispatchAgentMessage.mockResolvedValue(undefined);
  });

  it("does not immediately process queued work for scheduled chats", async () => {
    threadMocks.getThreadChat.mockResolvedValue({
      id: "chat-1",
      status: "scheduled",
    });

    await queueFollowUpInternal({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      messages: [TEST_USER_MESSAGE],
      appendOrReplace: "append",
      source: "github",
    });

    expect(threadMocks.updateThreadChat).toHaveBeenCalledTimes(1);
    expect(queueMocks.maybeProcessFollowUpQueue).not.toHaveBeenCalled();
  });
});

describe("followUpInternal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threadMocks.updateThreadChat.mockResolvedValue(undefined);
    queueMocks.maybeProcessFollowUpQueue.mockResolvedValue({
      processed: false,
      dispatchLaunched: false,
      reason: "no_queued_messages",
    });
    transitionMocks.updateThreadChatWithTransition.mockResolvedValue({
      didUpdateStatus: true,
      updatedStatus: "queued",
    });
  });

  it("queues direct follow-up submissions when the chat is already active", async () => {
    threadMocks.getThreadChat.mockResolvedValue({
      id: "chat-1",
      status: "working",
    });

    await followUpInternal({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      message: TEST_USER_MESSAGE,
      source: "www",
    });

    expect(
      transitionMocks.updateThreadChatWithTransition,
    ).not.toHaveBeenCalled();
    expect(threadMocks.updateThreadChat).toHaveBeenCalledWith({
      db: {},
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      updates: {
        appendQueuedMessages: [TEST_USER_MESSAGE],
        replaceQueuedMessages: undefined,
      },
    });
  });

  it("queues the follow-up if the chat becomes active before the status transition lands", async () => {
    threadMocks.getThreadChat
      .mockResolvedValueOnce({
        id: "chat-1",
        status: "complete",
      })
      .mockResolvedValueOnce({
        id: "chat-1",
        status: "working",
      })
      .mockResolvedValueOnce({
        id: "chat-1",
        status: "working",
      });
    transitionMocks.updateThreadChatWithTransition.mockResolvedValue({
      didUpdateStatus: false,
      updatedStatus: "queued",
    });

    await followUpInternal({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      message: TEST_USER_MESSAGE,
      source: "www",
    });

    expect(threadMocks.updateThreadChat).toHaveBeenCalledWith({
      db: {},
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      updates: {
        appendQueuedMessages: [TEST_USER_MESSAGE],
        replaceQueuedMessages: undefined,
      },
    });
  });
});
