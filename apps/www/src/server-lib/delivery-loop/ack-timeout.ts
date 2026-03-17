import { db } from "@/lib/db";
import { getStalledDispatchIntents } from "@terragon/shared/delivery-loop/store/dispatch-intent-store";
import { handleAckTimeout, DEFAULT_ACK_TIMEOUT_MS } from "./ack-lifecycle";
import { appendSignalToInbox } from "@terragon/shared/delivery-loop/store/signal-inbox-store";
import { runCoordinatorTick } from "./coordinator/tick";
import type {
  WorkflowId,
  CorrelationId,
} from "@terragon/shared/delivery-loop/domain/workflow";

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

    for (let j = 0; j < results.length; j++) {
      const result = results[j]!;
      const intent = batch[j]!;
      if (result.status === "fulfilled") {
        processedCount++;
        if (result.value.shouldRetry) {
          retriedCount++;
          try {
            await appendSignalToInbox({
              db,
              loopId: intent.loopId,
              causeType: "timer_dispatch_ack_expired",
              payload: {
                kind: "dispatch_ack_expired",
                consecutiveFailures: result.value.attempt,
              },
              canonicalCauseId: `ack-timeout-${intent.runId}`,
            });
            await runCoordinatorTick({
              db,
              workflowId: intent.loopId as WorkflowId,
              correlationId:
                `ack-timeout-sweep-${intent.runId}` as CorrelationId,
              loopId: intent.loopId,
            });
          } catch (retryErr) {
            console.error("[ack-timeout] failed to signal ack-expired retry", {
              runId: intent.runId,
              threadChatId: intent.threadChatId,
              error: retryErr,
            });
          }
        } else {
          console.warn(
            "[ack-timeout] retry budget exhausted, no retry scheduled",
            {
              runId: intent.runId,
              threadChatId: intent.threadChatId,
              attempt: result.value.attempt,
            },
          );
        }
      } else {
        console.error("[ack-timeout] failed to process stalled intent", {
          runId: intent.runId,
          error: result.reason,
        });
      }
    }
  }

  return { stalledCount: stalled.length, processedCount, retriedCount };
}
