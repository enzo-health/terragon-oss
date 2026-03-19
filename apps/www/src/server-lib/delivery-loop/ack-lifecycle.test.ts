import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockMarkDispatchIntentAcknowledged = vi.hoisted(() => vi.fn());
const mockMarkDispatchIntentFailed = vi.hoisted(() => vi.fn());
const mockGetDispatchIntentByRunId = vi.hoisted(() => vi.fn());

vi.mock("@terragon/shared/delivery-loop/store/dispatch-intent-store", () => ({
  markDispatchIntentAcknowledged: mockMarkDispatchIntentAcknowledged,
  markDispatchIntentFailed: mockMarkDispatchIntentFailed,
  getDispatchIntentByRunId: mockGetDispatchIntentByRunId,
}));

const mockUpdateDispatchIntent = vi.hoisted(() => vi.fn());
const mockBuildDispatchIntentId = vi.hoisted(() =>
  vi.fn((loopId: string, runId: string) => `di_${loopId}_${runId}`),
);
const mockGetActiveDispatchIntent = vi.hoisted(() => vi.fn());

vi.mock("./dispatch-intent", () => ({
  updateDispatchIntent: mockUpdateDispatchIntent,
  buildDispatchIntentId: mockBuildDispatchIntentId,
  getActiveDispatchIntent: mockGetActiveDispatchIntent,
}));

const mockResetRetryCounter = vi.hoisted(() => vi.fn());
const mockEvaluateRetryDecision = vi.hoisted(() => vi.fn());
const mockUpdateAgentRunContext = vi.hoisted(() => vi.fn());
const mockUpdateThreadChatStatusAtomic = vi.hoisted(() => vi.fn());

vi.mock("./retry-policy", () => ({
  resetRetryCounter: mockResetRetryCounter,
  evaluateRetryDecision: mockEvaluateRetryDecision,
}));

vi.mock("@terragon/shared/model/agent-run-context", () => ({
  updateAgentRunContext: mockUpdateAgentRunContext,
}));

vi.mock("@terragon/shared/model/threads", () => ({
  updateThreadChatStatusAtomic: mockUpdateThreadChatStatusAtomic,
}));

import {
  handleAckReceived,
  handleAckTimeout,
  startAckTimeout,
} from "./ack-lifecycle";

const fakeDb = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("handleAckReceived", () => {
  it("updates Redis intent, DB intent, and resets retry counter in parallel", async () => {
    mockGetActiveDispatchIntent.mockResolvedValue({
      id: "di_loop-1_run-1",
      runId: "run-1",
      status: "dispatched",
    });
    mockUpdateDispatchIntent.mockResolvedValue(undefined);
    mockMarkDispatchIntentAcknowledged.mockResolvedValue(true);
    mockResetRetryCounter.mockResolvedValue(undefined);

    await handleAckReceived({
      db: fakeDb,
      runId: "run-1",
      loopId: "loop-1",
      threadChatId: "tc-1",
    });

    expect(mockUpdateDispatchIntent).toHaveBeenCalledWith(
      "di_loop-1_run-1",
      "tc-1",
      { status: "acknowledged" },
    );
    expect(mockMarkDispatchIntentAcknowledged).toHaveBeenCalledWith(
      fakeDb,
      "run-1",
    );
    expect(mockResetRetryCounter).toHaveBeenCalledWith("tc-1");
  });

  it("acknowledges realtime intent when status is still prepared", async () => {
    mockGetActiveDispatchIntent.mockResolvedValue({
      id: "di_loop-1_run-1",
      runId: "run-1",
      status: "prepared",
    });
    mockUpdateDispatchIntent.mockResolvedValue(undefined);
    mockMarkDispatchIntentAcknowledged.mockResolvedValue(false);
    mockResetRetryCounter.mockResolvedValue(undefined);

    await handleAckReceived({
      db: fakeDb,
      runId: "run-1",
      loopId: "loop-1",
      threadChatId: "tc-1",
    });

    expect(mockUpdateDispatchIntent).toHaveBeenCalledWith(
      "di_loop-1_run-1",
      "tc-1",
      { status: "acknowledged" },
    );
    expect(mockResetRetryCounter).toHaveBeenCalledWith("tc-1");
  });

  it("does not rewrite realtime state when intent is already terminal", async () => {
    mockGetActiveDispatchIntent.mockResolvedValue({
      id: "di_loop-1_run-1",
      runId: "run-1",
      status: "completed",
    });
    mockMarkDispatchIntentAcknowledged.mockResolvedValue(false);

    await handleAckReceived({
      db: fakeDb,
      runId: "run-1",
      loopId: "loop-1",
      threadChatId: "tc-1",
    });

    expect(mockUpdateDispatchIntent).not.toHaveBeenCalled();
    expect(mockResetRetryCounter).not.toHaveBeenCalled();
  });
});

describe("handleAckTimeout", () => {
  it("marks intent as failed and evaluates retry policy", async () => {
    mockMarkDispatchIntentFailed.mockResolvedValue(undefined);
    mockUpdateAgentRunContext.mockResolvedValue(undefined);
    mockUpdateThreadChatStatusAtomic.mockResolvedValue({
      didUpdateStatus: true,
    });
    mockEvaluateRetryDecision.mockResolvedValue({
      shouldRetry: true,
      action: "retry_same_intent",
      attempt: 1,
      maxAttempts: 3,
      backoffMs: 500,
    });

    const outcome = await handleAckTimeout({
      db: fakeDb,
      runId: "run-1",
      threadChatId: "tc-1",
      userId: "user-1",
      threadId: "thread-1",
      timeoutMs: 30_000,
    });

    expect(outcome).toEqual({
      shouldRetry: true,
      action: "retry_same_intent",
      attempt: 1,
    });
    expect(mockMarkDispatchIntentFailed).toHaveBeenCalledWith(
      fakeDb,
      "run-1",
      "dispatch_ack_timeout",
      expect.stringContaining("30000ms"),
    );
    expect(mockEvaluateRetryDecision).toHaveBeenCalledWith({
      threadChatId: "tc-1",
      failureCategory: "dispatch_ack_timeout",
    });
    expect(mockUpdateAgentRunContext).toHaveBeenCalledWith({
      db: fakeDb,
      runId: "run-1",
      userId: "user-1",
      updates: { status: "failed" },
    });
    expect(mockUpdateThreadChatStatusAtomic).toHaveBeenCalledWith({
      db: fakeDb,
      userId: "user-1",
      threadId: "thread-1",
      threadChatId: "tc-1",
      fromStatus: "booting",
      toStatus: "complete",
    });
  });

  it("returns non-retryable when budget exhausted", async () => {
    mockMarkDispatchIntentFailed.mockResolvedValue(undefined);
    mockEvaluateRetryDecision.mockResolvedValue({
      shouldRetry: false,
      reason: "budget_exhausted",
      action: "retry_same_intent",
      attempt: 4,
      maxAttempts: 3,
    });

    const outcome = await handleAckTimeout({
      db: fakeDb,
      runId: "run-2",
      threadChatId: "tc-2",
    });

    expect(outcome.shouldRetry).toBe(false);
    expect(outcome.attempt).toBe(4);
    expect(mockUpdateAgentRunContext).not.toHaveBeenCalled();
    expect(mockUpdateThreadChatStatusAtomic).not.toHaveBeenCalled();
  });
});

describe("startAckTimeout", () => {
  it("calls handleAckTimeout after timeout when intent is still dispatched", async () => {
    mockGetDispatchIntentByRunId.mockResolvedValue({
      runId: "run-1",
      status: "dispatched",
      threadChatId: "tc-1",
    });
    mockMarkDispatchIntentFailed.mockResolvedValue(undefined);
    mockEvaluateRetryDecision.mockResolvedValue({
      shouldRetry: true,
      action: "retry_same_intent",
      attempt: 1,
      maxAttempts: 3,
      backoffMs: 500,
    });

    startAckTimeout({
      db: fakeDb,
      runId: "run-1",
      loopId: "loop-1",
      threadChatId: "tc-1",
      timeoutMs: 5_000,
    });

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockGetDispatchIntentByRunId).toHaveBeenCalledWith(fakeDb, "run-1");
    expect(mockMarkDispatchIntentFailed).toHaveBeenCalled();
  });

  it("skips handleAckTimeout when intent was already acknowledged", async () => {
    mockGetDispatchIntentByRunId.mockResolvedValue({
      runId: "run-2",
      status: "acknowledged",
      threadChatId: "tc-2",
    });

    startAckTimeout({
      db: fakeDb,
      runId: "run-2",
      loopId: "loop-2",
      threadChatId: "tc-2",
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockGetDispatchIntentByRunId).toHaveBeenCalledWith(fakeDb, "run-2");
    expect(mockMarkDispatchIntentFailed).not.toHaveBeenCalled();
  });

  it("returns a cleanup function that cancels the timeout", async () => {
    const cancel = startAckTimeout({
      db: fakeDb,
      runId: "run-3",
      loopId: "loop-3",
      threadChatId: "tc-3",
      timeoutMs: 5_000,
    });

    cancel();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockGetDispatchIntentByRunId).not.toHaveBeenCalled();
  });
});
