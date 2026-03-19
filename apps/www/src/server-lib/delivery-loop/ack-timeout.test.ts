import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetStalledDispatchIntents = vi.hoisted(() => vi.fn());

vi.mock("@terragon/shared/delivery-loop/store/dispatch-intent-store", () => ({
  getStalledDispatchIntents: mockGetStalledDispatchIntents,
}));

const mockHandleAckTimeout = vi.hoisted(() => vi.fn());

vi.mock("./ack-lifecycle", () => ({
  handleAckTimeout: mockHandleAckTimeout,
  DEFAULT_ACK_TIMEOUT_MS: 30_000,
}));

vi.mock("@/lib/db", () => ({
  db: {},
}));

import { sweepAckTimeouts } from "./ack-timeout";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sweepAckTimeouts", () => {
  it("returns zeros when no stalled intents found", async () => {
    mockGetStalledDispatchIntents.mockResolvedValue([]);

    const result = await sweepAckTimeouts();

    expect(result).toEqual({
      stalledCount: 0,
      processedCount: 0,
      retriedCount: 0,
    });
    expect(mockHandleAckTimeout).not.toHaveBeenCalled();
  });

  it("calls handleAckTimeout for stalled intents", async () => {
    mockGetStalledDispatchIntents.mockResolvedValue([
      {
        runId: "run-1",
        loopId: "loop-1",
        userId: "user-1",
        threadId: "thread-1",
        threadChatId: "tc-1",
      },
    ]);
    mockHandleAckTimeout.mockResolvedValue({
      shouldRetry: true,
      action: "retry_same_intent",
      attempt: 1,
    });

    const result = await sweepAckTimeouts();

    expect(result).toEqual({
      stalledCount: 1,
      processedCount: 1,
      retriedCount: 1,
    });
    expect(mockHandleAckTimeout).toHaveBeenCalledWith({
      db: {},
      runId: "run-1",
      threadChatId: "tc-1",
      userId: "user-1",
      threadId: "thread-1",
      timeoutMs: 30_000,
    });
  });

  it("counts non-retryable intents correctly", async () => {
    mockGetStalledDispatchIntents.mockResolvedValue([
      {
        runId: "run-2",
        loopId: "loop-2",
        userId: "user-2",
        threadId: "thread-2",
        threadChatId: "tc-2",
      },
    ]);
    mockHandleAckTimeout.mockResolvedValue({
      shouldRetry: false,
      action: "retry_same_intent",
      attempt: 4,
    });

    const result = await sweepAckTimeouts();

    expect(result).toEqual({
      stalledCount: 1,
      processedCount: 1,
      retriedCount: 0,
    });
  });

  it("handles errors for individual intents gracefully", async () => {
    mockGetStalledDispatchIntents.mockResolvedValue([
      {
        runId: "run-ok",
        loopId: "loop-ok",
        userId: "user-ok",
        threadId: "thread-ok",
        threadChatId: "tc-ok",
      },
      {
        runId: "run-err",
        loopId: "loop-err",
        userId: "user-err",
        threadId: "thread-err",
        threadChatId: "tc-err",
      },
    ]);
    mockHandleAckTimeout
      .mockResolvedValueOnce({
        shouldRetry: true,
        action: "retry_same_intent",
        attempt: 1,
      })
      .mockRejectedValueOnce(new Error("db error"));

    const result = await sweepAckTimeouts();

    expect(result).toEqual({
      stalledCount: 2,
      processedCount: 1,
      retriedCount: 1,
    });
  });
});
