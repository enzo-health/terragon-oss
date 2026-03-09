import { db } from "@/lib/db";
import {
  getStalledDispatchIntents,
  markDispatchIntentFailed,
} from "@terragon/shared/model/delivery-loop";
import { evaluateRetryDecision } from "./retry-policy";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long to wait after dispatch before declaring an ack timeout. */
const ACK_TIMEOUT_MS = 60_000; // 60 seconds

// ---------------------------------------------------------------------------
// Ack timeout sweep
// ---------------------------------------------------------------------------

export type AckTimeoutResult = {
  stalledCount: number;
  failedCount: number;
  retriedCount: number;
};

/**
 * Scans for dispatch intents stuck in "dispatched" status past the ack
 * timeout window. For each stalled intent:
 *
 * 1. Mark the intent as failed with `dispatch_ack_timeout`.
 * 2. Evaluate the retry policy to decide next action.
 * 3. Log the outcome (actual re-dispatch is handled by the retry
 *    infrastructure that runs on the next daemon terminal event or
 *    the stalled-tasks cron — this sweep only classifies the failure).
 *
 * This runs as a cron job (every minute) and is idempotent — once an
 * intent is marked "failed" it won't be picked up again.
 */
export async function sweepAckTimeouts(): Promise<AckTimeoutResult> {
  const stalled = await getStalledDispatchIntents(db, ACK_TIMEOUT_MS);

  if (stalled.length === 0) {
    return { stalledCount: 0, failedCount: 0, retriedCount: 0 };
  }

  let failedCount = 0;
  let retriedCount = 0;

  for (const intent of stalled) {
    try {
      await markDispatchIntentFailed(
        db,
        intent.runId,
        "dispatch_ack_timeout",
        `No daemon event received within ${ACK_TIMEOUT_MS}ms of dispatch`,
      );
      failedCount++;

      const decision = await evaluateRetryDecision({
        threadChatId: intent.threadChatId,
        failureCategory: "dispatch_ack_timeout",
      });

      if (decision.shouldRetry) {
        retriedCount++;
        console.log("[ack-timeout] stalled intent will be retried", {
          runId: intent.runId,
          loopId: intent.loopId,
          threadId: intent.threadId,
          threadChatId: intent.threadChatId,
          attempt: decision.attempt,
          action: decision.action,
          backoffMs: decision.backoffMs,
        });
      } else {
        console.warn("[ack-timeout] stalled intent retry budget exhausted", {
          runId: intent.runId,
          loopId: intent.loopId,
          threadId: intent.threadId,
          threadChatId: intent.threadChatId,
          reason: decision.reason,
          attempt: decision.attempt,
        });
      }
    } catch (error) {
      console.error("[ack-timeout] failed to process stalled intent", {
        runId: intent.runId,
        loopId: intent.loopId,
        error,
      });
    }
  }

  return { stalledCount: stalled.length, failedCount, retriedCount };
}
