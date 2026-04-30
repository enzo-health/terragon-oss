import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const threadMocks = vi.hoisted(() => ({
  getThreadChat: vi.fn(),
}));

const stopThreadMocks = vi.hoisted(() => ({
  stopThread: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { label: "db" },
}));

vi.mock("@terragon/shared/model/threads", () => ({
  getThreadChat: threadMocks.getThreadChat,
}));

// The adapter imports stopThread from @/server-lib/stop-thread (the internal
// function, not the userOnlyAction wrapper in server-actions/).
vi.mock("@/server-lib/stop-thread", () => ({
  stopThread: stopThreadMocks.stopThread,
}));

import { cancelThreadFromAgUiInput } from "./cancel-from-ag-ui";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const THREAD_CHAT_ROW = {
  id: "chat-1",
  status: "complete",
  userId: "user-1",
  threadId: "thread-1",
};

const BASE_ARGS = {
  threadId: "thread-1",
  threadChatId: "chat-1",
  userId: "user-1",
  isReplayMode: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cancelThreadFromAgUiInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default happy-path mocks
    threadMocks.getThreadChat.mockResolvedValue(THREAD_CHAT_ROW);
    stopThreadMocks.stopThread.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Replay-mode bypass
  // -------------------------------------------------------------------------

  describe("replay-mode bypass", () => {
    it("returns { skipped: 'replay-mode' } immediately", async () => {
      const result = await cancelThreadFromAgUiInput({
        ...BASE_ARGS,
        isReplayMode: true,
      });

      expect(result).toEqual({ skipped: "replay-mode" });
    });

    it("does NOT call getThreadChat in replay mode", async () => {
      await cancelThreadFromAgUiInput({ ...BASE_ARGS, isReplayMode: true });

      expect(threadMocks.getThreadChat).not.toHaveBeenCalled();
    });

    it("does NOT call stopThreadInternal in replay mode", async () => {
      await cancelThreadFromAgUiInput({ ...BASE_ARGS, isReplayMode: true });

      expect(stopThreadMocks.stopThread).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Ownership validation
  // -------------------------------------------------------------------------

  describe("ownership validation", () => {
    it("returns { error: { kind: 'unauthorized' } } when getThreadChat returns undefined", async () => {
      threadMocks.getThreadChat.mockResolvedValue(undefined);

      const result = await cancelThreadFromAgUiInput(BASE_ARGS);

      expect(result).toEqual({ error: { kind: "unauthorized" } });
    });

    it("returns { error: { kind: 'unauthorized' } } when getThreadChat returns null", async () => {
      threadMocks.getThreadChat.mockResolvedValue(null);

      const result = await cancelThreadFromAgUiInput(BASE_ARGS);

      expect(result).toEqual({ error: { kind: "unauthorized" } });
    });

    it("does NOT call stopThreadInternal when ownership check fails", async () => {
      threadMocks.getThreadChat.mockResolvedValue(undefined);

      await cancelThreadFromAgUiInput(BASE_ARGS);

      expect(stopThreadMocks.stopThread).not.toHaveBeenCalled();
    });

    it("passes the correct userId, threadId, threadChatId to getThreadChat", async () => {
      await cancelThreadFromAgUiInput(BASE_ARGS);

      expect(threadMocks.getThreadChat).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          threadChatId: "chat-1",
          userId: "user-1",
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Successful path
  // -------------------------------------------------------------------------

  describe("successful cancel", () => {
    it("returns { ok: true } on success", async () => {
      const result = await cancelThreadFromAgUiInput(BASE_ARGS);

      expect(result).toEqual({ ok: true });
    });

    it("calls stopThreadInternal with the correct arguments", async () => {
      await cancelThreadFromAgUiInput(BASE_ARGS);

      expect(stopThreadMocks.stopThread).toHaveBeenCalledWith({
        userId: "user-1",
        threadId: "thread-1",
        threadChatId: "chat-1",
      });
    });

    it("calls stopThreadInternal exactly once", async () => {
      await cancelThreadFromAgUiInput(BASE_ARGS);

      expect(stopThreadMocks.stopThread).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  describe("error propagation", () => {
    it("propagates errors thrown by stopThreadInternal", async () => {
      stopThreadMocks.stopThread.mockRejectedValue(new Error("daemon error"));

      await expect(cancelThreadFromAgUiInput(BASE_ARGS)).rejects.toThrow(
        "daemon error",
      );
    });
  });
});
