import { beforeEach, describe, expect, it, vi } from "vitest";

const threadMocks = vi.hoisted(() => ({
  getStalledThreadChats: vi.fn(),
}));

const updateStatusMocks = vi.hoisted(() => ({
  updateThreadChatWithTransition: vi.fn(),
}));

const sandboxMocks = vi.hoisted(() => ({
  setActiveThreadChat: vi.fn(),
  maybeHibernateSandboxById: vi.fn(),
}));

const runContextMocks = vi.hoisted(() => ({
  getLatestAgentRunContextForThreadChat: vi.fn(),
  completeAgentRunContextTerminal: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const db = {
    label: "db",
    // The run-terminal choke point fences + transitions inside one transaction;
    // pass the callback the same mock handle since the model calls are mocked.
    transaction: (callback: (tx: unknown) => unknown) => callback(db),
  };
  return { db };
});

vi.mock("@terragon/shared/model/threads", () => ({
  getStalledThreadChats: threadMocks.getStalledThreadChats,
}));

vi.mock("@/agent/update-status", () => ({
  updateThreadChatWithTransition:
    updateStatusMocks.updateThreadChatWithTransition,
}));

vi.mock("@/agent/sandbox-resource", () => ({
  setActiveThreadChat: sandboxMocks.setActiveThreadChat,
}));

vi.mock("@/agent/sandbox", () => ({
  maybeHibernateSandboxById: sandboxMocks.maybeHibernateSandboxById,
}));

vi.mock("@terragon/shared/model/agent-run-context", () => ({
  getLatestAgentRunContextForThreadChat:
    runContextMocks.getLatestAgentRunContextForThreadChat,
  completeAgentRunContextTerminal:
    runContextMocks.completeAgentRunContextTerminal,
}));

import { db } from "@/lib/db";
import {
  RUN_DEADLINE_CUTOFF_SECS,
  runDeadlineSweep,
} from "./run-deadline-sweep";

function stalledChat(overrides: Record<string, unknown> = {}) {
  return {
    id: "chat-1",
    threadId: "thread-1",
    status: "working",
    updatedAt: new Date(),
    codesandboxId: "sandbox-1",
    sandboxProvider: "e2b",
    userId: "user-1",
    ...overrides,
  };
}

describe("runDeadlineSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threadMocks.getStalledThreadChats.mockResolvedValue([]);
    updateStatusMocks.updateThreadChatWithTransition.mockResolvedValue({
      didUpdateStatus: true,
      updatedStatus: "complete",
    });
    sandboxMocks.setActiveThreadChat.mockResolvedValue(undefined);
    sandboxMocks.maybeHibernateSandboxById.mockResolvedValue(undefined);
    runContextMocks.getLatestAgentRunContextForThreadChat.mockResolvedValue({
      runId: "run-1",
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "chat-1",
      transportMode: "acp",
      protocolVersion: 2,
      runtimeProvider: "e2b",
      daemonTokenKeyId: null,
      status: "processing",
      lastAcceptedSeq: 3,
    });
    runContextMocks.completeAgentRunContextTerminal.mockResolvedValue({
      status: "committed",
    });
  });

  describe("selection", () => {
    it("queries getStalledThreadChats with the short cutoff", async () => {
      await runDeadlineSweep({ db });

      expect(threadMocks.getStalledThreadChats).toHaveBeenCalledWith({
        db,
        cutoffSecs: RUN_DEADLINE_CUTOFF_SECS,
      });
    });

    it("uses a cutoff shorter than the hourly coarse net", async () => {
      expect(RUN_DEADLINE_CUTOFF_SECS).toBeLessThan(60 * 60);
    });

    it("forwards an explicit cutoff override", async () => {
      await runDeadlineSweep({ db, cutoffSecs: 300 });

      expect(threadMocks.getStalledThreadChats).toHaveBeenCalledWith({
        db,
        cutoffSecs: 300,
      });
    });

    it("does nothing when no thread chats are stalled", async () => {
      const result = await runDeadlineSweep({ db });

      expect(
        updateStatusMocks.updateThreadChatWithTransition,
      ).not.toHaveBeenCalled();
      expect(result).toEqual({ scanned: 0, terminated: 0, skipped: 0 });
    });
  });

  describe("per-row action", () => {
    it("drives each stalled chat to terminal via system.error", async () => {
      threadMocks.getStalledThreadChats.mockResolvedValue([
        stalledChat({ id: "chat-1" }),
        stalledChat({ id: "chat-2", threadId: "thread-2", userId: "user-2" }),
      ]);

      const result = await runDeadlineSweep({ db });

      expect(
        updateStatusMocks.updateThreadChatWithTransition,
      ).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ scanned: 2, terminated: 2, skipped: 0 });
    });

    it("passes the chat identity and a system.error transition", async () => {
      threadMocks.getStalledThreadChats.mockResolvedValue([stalledChat()]);

      await runDeadlineSweep({ db });

      expect(
        updateStatusMocks.updateThreadChatWithTransition,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          threadId: "thread-1",
          threadChatId: "chat-1",
          eventType: "system.error",
        }),
      );
    });

    it("uses an honest deadline reason, not 'completed'", async () => {
      threadMocks.getStalledThreadChats.mockResolvedValue([stalledChat()]);

      await runDeadlineSweep({ db });

      const call =
        updateStatusMocks.updateThreadChatWithTransition.mock.calls[0]![0];
      expect(call.chatUpdates.errorMessage).toBe("agent-generic-error");
      expect(call.chatUpdates.errorMessageInfo).toContain("deadline");
      expect(call.chatUpdates.errorMessageInfo).not.toContain("completed");
      expect(call.chatUpdates.appendMessages).toHaveLength(1);
      expect(call.chatUpdates.appendMessages[0].error_info).toContain(
        "deadline",
      );
    });

    it("clears queued messages so a stale follow-up does not relaunch", async () => {
      threadMocks.getStalledThreadChats.mockResolvedValue([stalledChat()]);

      await runDeadlineSweep({ db });

      const call =
        updateStatusMocks.updateThreadChatWithTransition.mock.calls[0]![0];
      expect(call.chatUpdates.replaceQueuedMessages).toEqual([]);
    });

    it("closes the run-context through a fenced terminal keyed to the runId", async () => {
      threadMocks.getStalledThreadChats.mockResolvedValue([stalledChat()]);

      await runDeadlineSweep({ db });

      expect(
        runContextMocks.completeAgentRunContextTerminal,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          terminalStatus: "failed",
          terminalEventId: "deadline-sweep:run-1",
          lastAcceptedSeq: 4,
        }),
      );
    });

    it("skips the run-context close when no run-context exists for the chat", async () => {
      threadMocks.getStalledThreadChats.mockResolvedValue([stalledChat()]);
      runContextMocks.getLatestAgentRunContextForThreadChat.mockResolvedValue(
        null,
      );

      await runDeadlineSweep({ db });

      expect(
        runContextMocks.completeAgentRunContextTerminal,
      ).not.toHaveBeenCalled();
    });
  });

  describe("idempotency and resilience", () => {
    it("counts a no-op transition as skipped, not terminated", async () => {
      threadMocks.getStalledThreadChats.mockResolvedValue([stalledChat()]);
      updateStatusMocks.updateThreadChatWithTransition.mockResolvedValue({
        didUpdateStatus: false,
        updatedStatus: "complete",
      });

      const result = await runDeadlineSweep({ db });

      expect(result).toEqual({ scanned: 1, terminated: 0, skipped: 1 });
    });

    it("continues to the next chat when one transition throws", async () => {
      threadMocks.getStalledThreadChats.mockResolvedValue([
        stalledChat({ id: "chat-1" }),
        stalledChat({ id: "chat-2" }),
      ]);
      updateStatusMocks.updateThreadChatWithTransition
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({
          didUpdateStatus: true,
          updatedStatus: "complete",
        });

      const result = await runDeadlineSweep({ db });

      expect(
        updateStatusMocks.updateThreadChatWithTransition,
      ).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ scanned: 2, terminated: 1, skipped: 1 });
    });
  });
});
