import { db } from "@/lib/db";
import { getStalledDispatchIntents } from "@terragon/shared/model/delivery-loop";
import { handleAckTimeout, DEFAULT_ACK_TIMEOUT_MS } from "./ack-lifecycle";

// ---------------------------------------------------------------------------
// Ack timeout sweep
// ---------------------------------------------------------------------------

export type AckTimeoutResult = {
  stalledCount: number;
  failedCount: number;
  retriedCount: number;
};

/**
 * Cron-driven sweep that finds dispatch intents stuck in "dispatched"
 * status past the ack timeout window and processes them via
 * `handleAckTimeout`. This is a durable fallback for the in-process
 * timer set by `startAckTimeout` — it catches cases where the server
 * process restarted before the timer fired.
 *
 * Runs every minute and is idempotent — once an intent is marked
 * "failed" it won't be picked up again.
 */
export async function sweepAckTimeouts(): Promise<AckTimeoutResult> {
  const stalled = await getStalledDispatchIntents(db, DEFAULT_ACK_TIMEOUT_MS);

  if (stalled.length === 0) {
    return { stalledCount: 0, failedCount: 0, retriedCount: 0 };
  }

  let failedCount = 0;
  let retriedCount = 0;

  for (const intent of stalled) {
    try {
      const outcome = await handleAckTimeout({
        db,
        runId: intent.runId,
        threadChatId: intent.threadChatId,
        timeoutMs: DEFAULT_ACK_TIMEOUT_MS,
      });
      failedCount++;

      if (outcome.shouldRetry) {
        retriedCount++;
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
