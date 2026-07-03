import { beforeEach, describe, expect, it, vi } from "vitest";

const runContextMocks = vi.hoisted(() => ({
  completeAgentRunContextTerminal: vi.fn(),
}));
const updateStatusMocks = vi.hoisted(() => ({
  updateThreadChatWithTransition: vi.fn(),
}));

vi.mock("@terragon/shared/model/agent-run-context", () => ({
  completeAgentRunContextTerminal:
    runContextMocks.completeAgentRunContextTerminal,
}));

vi.mock("@/agent/update-status", () => ({
  updateThreadChatWithTransition:
    updateStatusMocks.updateThreadChatWithTransition,
}));

import { commitTerminalRunAndChatStatus } from "./commit-terminal-run";

const db = {
  transaction: (callback: (tx: unknown) => unknown) => callback({ tx: true }),
} as never;

const FENCE = {
  runId: "run-1",
  userId: "user-1",
  threadId: "thread-1",
  threadChatId: "chat-1",
  transportMode: "acp" as const,
  protocolVersion: 2 as const,
  runtimeProvider: null,
  daemonTokenKeyId: null,
  terminalStatus: "completed" as const,
  lastAcceptedSeq: 5,
  terminalEventId: "evt-1",
};

const TRANSITION = {
  userId: "user-1",
  threadId: "thread-1",
  threadChatId: "chat-1",
  eventType: "assistant.message_done" as const,
};

describe("commitTerminalRunAndChatStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateStatusMocks.updateThreadChatWithTransition.mockResolvedValue({
      didUpdateStatus: true,
      updatedStatus: "working-done",
    });
  });

  it("transitions without fencing when no run-context is supplied", async () => {
    const result = await commitTerminalRunAndChatStatus({
      db,
      fence: null,
      transition: TRANSITION,
    });

    expect(
      runContextMocks.completeAgentRunContextTerminal,
    ).not.toHaveBeenCalled();
    expect(
      updateStatusMocks.updateThreadChatWithTransition,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "assistant.message_done" }),
    );
    expect(result.fence).toBeNull();
    expect(result.reconciled).toBe(false);
  });

  it("applies the caller transition when the fence commits", async () => {
    runContextMocks.completeAgentRunContextTerminal.mockResolvedValue({
      status: "committed",
      runContext: { status: "completed" },
    });

    const result = await commitTerminalRunAndChatStatus({
      db,
      fence: FENCE,
      transition: TRANSITION,
    });

    expect(result.fence?.status).toBe("committed");
    expect(
      updateStatusMocks.updateThreadChatWithTransition,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "assistant.message_done" }),
    );
    expect(result.reconciled).toBe(false);
  });

  it("still applies the caller transition on a duplicate fence", async () => {
    runContextMocks.completeAgentRunContextTerminal.mockResolvedValue({
      status: "duplicate",
      runContext: { status: "completed" },
    });

    const result = await commitTerminalRunAndChatStatus({
      db,
      fence: FENCE,
      transition: TRANSITION,
    });

    expect(result.fence?.status).toBe("duplicate");
    expect(
      updateStatusMocks.updateThreadChatWithTransition,
    ).toHaveBeenCalledTimes(1);
  });

  it("reconciles the chat to the winning terminal on already_terminal_different_event", async () => {
    runContextMocks.completeAgentRunContextTerminal.mockResolvedValue({
      status: "rejected",
      reason: "already_terminal_different_event",
      runContext: { status: "stopped" },
    });

    const result = await commitTerminalRunAndChatStatus({
      db,
      fence: FENCE,
      transition: TRANSITION,
    });

    expect(result.reconciled).toBe(true);
    expect(
      updateStatusMocks.updateThreadChatWithTransition,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "assistant.message_stop" }),
    );
  });

  it("does not transition when the fence is rejected as stale", async () => {
    runContextMocks.completeAgentRunContextTerminal.mockResolvedValue({
      status: "rejected",
      reason: "stale_run",
      runContext: { status: "processing" },
    });

    const result = await commitTerminalRunAndChatStatus({
      db,
      fence: FENCE,
      transition: TRANSITION,
    });

    expect(result.transition).toBeNull();
    expect(result.reconciled).toBe(false);
    expect(
      updateStatusMocks.updateThreadChatWithTransition,
    ).not.toHaveBeenCalled();
  });
});
