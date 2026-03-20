import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DBUserMessage } from "@terragon/shared";

const threadMocks = vi.hoisted(() => ({
  getThreadChat: vi.fn(),
  updateThreadChat: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
  maybeProcessFollowUpQueue: vi.fn(),
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
  updateThreadChat: threadMocks.updateThreadChat,
  getThreadMinimal: vi.fn(),
}));

vi.mock("./process-follow-up-queue", () => ({
  maybeProcessFollowUpQueue: queueMocks.maybeProcessFollowUpQueue,
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

import { queueFollowUpInternal } from "./follow-up";

const TEST_USER_MESSAGE = {
  type: "user",
  model: null,
  parts: [{ type: "text", text: "follow up" }],
} satisfies DBUserMessage;

describe("queueFollowUpInternal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threadMocks.updateThreadChat.mockResolvedValue(undefined);
    queueMocks.maybeProcessFollowUpQueue.mockResolvedValue({
      processed: false,
      dispatchLaunched: false,
      reason: "no_queued_messages",
    });
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
