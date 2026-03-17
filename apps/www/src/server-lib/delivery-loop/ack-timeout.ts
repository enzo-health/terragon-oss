import { db } from "@/lib/db";
import { getStalledDispatchIntents } from "@terragon/shared/delivery-loop/store/dispatch-intent-store";
import { handleAckTimeout, DEFAULT_ACK_TIMEOUT_MS } from "./ack-lifecycle";

// ---------------------------------------------------------------------------
// Ack timeout sweep
// ---------------------------------------------------------------------------

export type AckTimeoutResult = {
  stalledCount: number;
  processedCount: number;
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
    return { stalledCount: 0, processedCount: 0, retriedCount: 0 };
  }

  let processedCount = 0;
  let retriedCount = 0;

  const BATCH_SIZE = 10;
  for (let i = 0; i < stalled.length; i += BATCH_SIZE) {
    const batch = stalled.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((intent) =>
        handleAckTimeout({
          db,
          runId: intent.runId,
          threadChatId: intent.threadChatId,
          timeoutMs: DEFAULT_ACK_TIMEOUT_MS,
        }),
      ),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        processedCount++;
        if (result.value.shouldRetry) {
          retriedCount++;
        }
      } else {
        console.error("[ack-timeout] failed to process stalled intent", {
          error: result.reason,
        });
      }
    }
  }

  return { stalledCount: stalled.length, processedCount, retriedCount };
}
