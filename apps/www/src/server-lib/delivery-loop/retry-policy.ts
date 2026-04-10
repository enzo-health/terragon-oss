import {
  DELIVERY_LOOP_FAILURE_ACTION_TABLE,
  type DeliveryLoopFailureCategory,
  type DeliveryLoopRetryAction,
} from "@leo/shared/delivery-loop/domain/failure";
import { redis } from "@/lib/redis";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of auto-retry attempts per thread-chat error cycle. */
const MAX_RETRY_ATTEMPTS = 3;

/** Redis key prefix for retry attempt counters. */
const RETRY_COUNTER_PREFIX = "dlr:";

/** TTL for retry counters — 1 hour. After this the counter resets, which is
 *  fine because a stuck thread would have been noticed by then. */
const RETRY_COUNTER_TTL_SECONDS = 60 * 60;

/** Base delay in ms for exponential backoff (not currently used for scheduling
 *  but exposed so callers can compute a wait if needed). */
const BASE_BACKOFF_MS = 1_000;

/** Maximum backoff cap in ms. */
const MAX_BACKOFF_MS = 30_000;

// ---------------------------------------------------------------------------
// Retry decision
// ---------------------------------------------------------------------------

export type RetryDecision =
  | {
      shouldRetry: true;
      action: DeliveryLoopRetryAction;
      attempt: number;
      maxAttempts: number;
      backoffMs: number;
    }
  | {
      shouldRetry: false;
      reason: "non_retryable" | "budget_exhausted";
      action: DeliveryLoopRetryAction;
      attempt: number;
      maxAttempts: number;
    };

/**
 * Compute the backoff delay for a given attempt number using exponential
 * backoff with full jitter (AWS-style).
 *
 * delay = random(0, min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2^attempt))
 */
export function computeBackoffMs(attempt: number): number {
  const exponential = Math.min(
    MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * Math.pow(2, attempt),
  );
  return Math.floor(Math.random() * exponential);
}

/**
 * Build the Redis key for tracking retry attempts.
 * Scoped to thread chat so each error cycle gets its own counter.
 */
function retryCounterKey(threadChatId: string): string {
  return `${RETRY_COUNTER_PREFIX}${threadChatId}`;
}

/**
 * Evaluate whether a failed dispatch should be retried, and if so, what
 * action to take. Atomically increments the attempt counter in Redis.
 *
 * The decision flow:
 * 1. Look up the prescribed action from the failure action table.
 * 2. If action is "blocked", return non-retryable immediately.
 * 3. If action is "return_to_implementing", return non-retryable (this is a
 *    phase transition, not a retry — handled by the SDLC state machine).
 * 4. For retryable actions, increment the attempt counter.
 * 5. If attempt > MAX_RETRY_ATTEMPTS, budget exhausted.
 * 6. Otherwise, return retry with the action and backoff delay.
 */
export async function evaluateRetryDecision({
  threadChatId,
  failureCategory,
}: {
  threadChatId: string;
  failureCategory: DeliveryLoopFailureCategory;
}): Promise<RetryDecision> {
  const action = DELIVERY_LOOP_FAILURE_ACTION_TABLE[failureCategory];

  // Non-retryable categories — don't even touch the counter
  if (action === "blocked" || action === "return_to_implementing") {
    return {
      shouldRetry: false,
      reason: "non_retryable",
      action,
      attempt: 0,
      maxAttempts: MAX_RETRY_ATTEMPTS,
    };
  }

  // Retryable — atomically increment attempt counter and refresh TTL
  const key = retryCounterKey(threadChatId);
  const pipeline = redis.pipeline();
  pipeline.incr(key);
  pipeline.expire(key, RETRY_COUNTER_TTL_SECONDS);
  const [attempt] = (await pipeline.exec()) as [number, number];

  if (attempt > MAX_RETRY_ATTEMPTS) {
    return {
      shouldRetry: false,
      reason: "budget_exhausted",
      action,
      attempt,
      maxAttempts: MAX_RETRY_ATTEMPTS,
    };
  }

  return {
    shouldRetry: true,
    action,
    attempt,
    maxAttempts: MAX_RETRY_ATTEMPTS,
    backoffMs: computeBackoffMs(attempt - 1),
  };
}

/**
 * Reset the retry counter for a thread chat. Call this when a dispatch
 * succeeds (e.g., daemon acks the message) to clear stale retry state.
 */
export async function resetRetryCounter(threadChatId: string): Promise<void> {
  await redis.del(retryCounterKey(threadChatId));
}

// Re-export for convenience
export { MAX_RETRY_ATTEMPTS };
