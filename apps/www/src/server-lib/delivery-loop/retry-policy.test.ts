import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedis = vi.hoisted(() => ({
  incr: vi.fn(),
  expire: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  redis: mockRedis,
}));

import {
  computeBackoffMs,
  evaluateRetryDecision,
  resetRetryCounter,
  MAX_RETRY_ATTEMPTS,
} from "./retry-policy";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("computeBackoffMs", () => {
  it("returns a value within the expected range for attempt 0", () => {
    for (let i = 0; i < 50; i++) {
      const ms = computeBackoffMs(0);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(1_000); // BASE_BACKOFF_MS * 2^0
    }
  });

  it("returns a value within the expected range for attempt 2", () => {
    for (let i = 0; i < 50; i++) {
      const ms = computeBackoffMs(2);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(4_000); // BASE_BACKOFF_MS * 2^2
    }
  });

  it("caps at MAX_BACKOFF_MS for large attempts", () => {
    for (let i = 0; i < 50; i++) {
      const ms = computeBackoffMs(20);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(30_000);
    }
  });
});

describe("evaluateRetryDecision", () => {
  describe("non-retryable categories", () => {
    it("returns non-retryable for config_error (blocked)", async () => {
      const result = await evaluateRetryDecision({
        threadChatId: "tc-1",
        failureCategory: "config_error",
      });

      expect(result.shouldRetry).toBe(false);
      if (!result.shouldRetry) {
        expect(result.reason).toBe("non_retryable");
        expect(result.action).toBe("blocked");
      }
      // Should not touch Redis
      expect(mockRedis.incr).not.toHaveBeenCalled();
    });

    it("returns non-retryable for gate_failed (return_to_implementing)", async () => {
      const result = await evaluateRetryDecision({
        threadChatId: "tc-1",
        failureCategory: "gate_failed",
      });

      expect(result.shouldRetry).toBe(false);
      if (!result.shouldRetry) {
        expect(result.reason).toBe("non_retryable");
        expect(result.action).toBe("return_to_implementing");
      }
      expect(mockRedis.incr).not.toHaveBeenCalled();
    });

    it("returns non-retryable for codex_subagent_failed (return_to_implementing)", async () => {
      const result = await evaluateRetryDecision({
        threadChatId: "tc-1",
        failureCategory: "codex_subagent_failed",
      });

      expect(result.shouldRetry).toBe(false);
      if (!result.shouldRetry) {
        expect(result.reason).toBe("non_retryable");
        expect(result.action).toBe("return_to_implementing");
      }
    });
  });

  describe("retryable categories", () => {
    it("returns retry for daemon_unreachable on first attempt", async () => {
      mockRedis.incr.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);

      const result = await evaluateRetryDecision({
        threadChatId: "tc-2",
        failureCategory: "daemon_unreachable",
      });

      expect(result.shouldRetry).toBe(true);
      if (result.shouldRetry) {
        expect(result.action).toBe("rerun_prepare_and_retry");
        expect(result.attempt).toBe(1);
        expect(result.backoffMs).toBeGreaterThanOrEqual(0);
      }
      expect(mockRedis.incr).toHaveBeenCalledWith("dlr:tc-2");
      expect(mockRedis.expire).toHaveBeenCalledWith("dlr:tc-2", 60 * 60);
    });

    it("sets TTL only on first attempt", async () => {
      mockRedis.incr.mockResolvedValue(2);

      await evaluateRetryDecision({
        threadChatId: "tc-3",
        failureCategory: "dispatch_ack_timeout",
      });

      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it("returns retry_same_intent for dispatch_ack_timeout", async () => {
      mockRedis.incr.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);

      const result = await evaluateRetryDecision({
        threadChatId: "tc-4",
        failureCategory: "dispatch_ack_timeout",
      });

      expect(result.shouldRetry).toBe(true);
      if (result.shouldRetry) {
        expect(result.action).toBe("retry_same_intent");
      }
    });

    it("returns retry_if_budget for claude_runtime_exit", async () => {
      mockRedis.incr.mockResolvedValue(2);

      const result = await evaluateRetryDecision({
        threadChatId: "tc-5",
        failureCategory: "claude_runtime_exit",
      });

      expect(result.shouldRetry).toBe(true);
      if (result.shouldRetry) {
        expect(result.action).toBe("retry_if_budget");
        expect(result.attempt).toBe(2);
      }
    });

    it("returns budget_exhausted when attempts exceed max", async () => {
      mockRedis.incr.mockResolvedValue(MAX_RETRY_ATTEMPTS + 1);

      const result = await evaluateRetryDecision({
        threadChatId: "tc-6",
        failureCategory: "daemon_unreachable",
      });

      expect(result.shouldRetry).toBe(false);
      if (!result.shouldRetry) {
        expect(result.reason).toBe("budget_exhausted");
        expect(result.attempt).toBe(MAX_RETRY_ATTEMPTS + 1);
      }
    });

    it("returns retry on exactly MAX_RETRY_ATTEMPTS", async () => {
      mockRedis.incr.mockResolvedValue(MAX_RETRY_ATTEMPTS);

      const result = await evaluateRetryDecision({
        threadChatId: "tc-7",
        failureCategory: "codex_app_server_exit",
      });

      expect(result.shouldRetry).toBe(true);
      if (result.shouldRetry) {
        expect(result.attempt).toBe(MAX_RETRY_ATTEMPTS);
      }
    });
  });
});

describe("resetRetryCounter", () => {
  it("deletes the Redis key", async () => {
    mockRedis.del.mockResolvedValue(1);

    await resetRetryCounter("tc-8");

    expect(mockRedis.del).toHaveBeenCalledWith("dlr:tc-8");
  });
});
