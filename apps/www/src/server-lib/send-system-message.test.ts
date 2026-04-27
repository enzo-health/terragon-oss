import type { DBSystemMessage } from "@terragon/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transitionMocks = vi.hoisted(() => ({
  updateThreadChatWithTransition: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { label: "db" },
}));

vi.mock("@/agent/msg/startAgentMessage", () => ({
  dispatchAgentMessage: vi.fn(),
}));

vi.mock("@/agent/update-status", () => ({
  updateThreadChatWithTransition:
    transitionMocks.updateThreadChatWithTransition,
}));

vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({
    capture: vi.fn(),
  }),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

const { sendSystemMessage } = await import("./send-system-message");

const retryMessage = {
  type: "system",
  message_type: "retry-git-commit-and-push",
  parts: [{ type: "text", text: "Retry" }],
} satisfies DBSystemMessage;

describe("sendSystemMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transitionMocks.updateThreadChatWithTransition.mockResolvedValue({
      didUpdateStatus: true,
      updatedStatus: "complete",
      chatSequence: 12,
    });
  });

  it("appends the retry notice as a persisted lifecycle message", async () => {
    await sendSystemMessage({
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      message: retryMessage,
    });

    expect(transitionMocks.updateThreadChatWithTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        threadChatId: "chat-1",
        chatUpdates: expect.objectContaining({
          appendMessages: [retryMessage],
        }),
      }),
    );
  });
});
