import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetStalledDispatchIntents = vi.hoisted(() => vi.fn());
const mockMarkDispatchIntentFailed = vi.hoisted(() => vi.fn());
const mockEvaluateRetryDecision = vi.hoisted(() => vi.fn());

vi.mock("@terragon/shared/model/delivery-loop", () => ({
  getStalledDispatchIntents: mockGetStalledDispatchIntents,
  markDispatchIntentFailed: mockMarkDispatchIntentFailed,
}));

vi.mock("./retry-policy", () => ({
  evaluateRetryDecision: mockEvaluateRetryDecision,
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
      failedCount: 0,
      retriedCount: 0,
    });
    expect(mockMarkDispatchIntentFailed).not.toHaveBeenCalled();
  });

  it("marks stalled intents as failed with dispatch_ack_timeout", async () => {
    mockGetStalledDispatchIntents.mockResolvedValue([
      {
        runId: "run-1",
        loopId: "loop-1",
        threadId: "thread-1",
        threadChatId: "tc-1",
      },
    ]);
    mockMarkDispatchIntentFailed.mockResolvedValue(undefined);
    mockEvaluateRetryDecision.mockResolvedValue({
      shouldRetry: true,
      action: "retry_same_intent",
      attempt: 1,
      maxAttempts: 3,
      backoffMs: 500,
    });

    const result = await sweepAckTimeouts();

    expect(result).toEqual({
      stalledCount: 1,
      failedCount: 1,
      retriedCount: 1,
    });
    expect(mockMarkDispatchIntentFailed).toHaveBeenCalledWith(
      {},
      "run-1",
      "dispatch_ack_timeout",
      expect.stringContaining("No daemon event received"),
    );
    expect(mockEvaluateRetryDecision).toHaveBeenCalledWith({
      threadChatId: "tc-1",
      failureCategory: "dispatch_ack_timeout",
    });
  });

  it("counts non-retryable intents correctly", async () => {
    mockGetStalledDispatchIntents.mockResolvedValue([
      {
        runId: "run-2",
        loopId: "loop-2",
        threadId: "thread-2",
        threadChatId: "tc-2",
      },
    ]);
    mockMarkDispatchIntentFailed.mockResolvedValue(undefined);
    mockEvaluateRetryDecision.mockResolvedValue({
      shouldRetry: false,
      reason: "budget_exhausted",
      action: "retry_same_intent",
      attempt: 4,
      maxAttempts: 3,
    });

    const result = await sweepAckTimeouts();

    expect(result).toEqual({
      stalledCount: 1,
      failedCount: 1,
      retriedCount: 0,
    });
  });

  it("handles errors for individual intents gracefully", async () => {
    mockGetStalledDispatchIntents.mockResolvedValue([
      {
        runId: "run-ok",
        loopId: "loop-ok",
        threadId: "thread-ok",
        threadChatId: "tc-ok",
      },
      {
        runId: "run-err",
        loopId: "loop-err",
        threadId: "thread-err",
        threadChatId: "tc-err",
      },
    ]);
    mockMarkDispatchIntentFailed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("db error"));
    mockEvaluateRetryDecision.mockResolvedValue({
      shouldRetry: true,
      action: "retry_same_intent",
      attempt: 1,
      maxAttempts: 3,
      backoffMs: 500,
    });

    const result = await sweepAckTimeouts();

    expect(result).toEqual({
      stalledCount: 2,
      failedCount: 1,
      retriedCount: 1,
    });
  });
});
