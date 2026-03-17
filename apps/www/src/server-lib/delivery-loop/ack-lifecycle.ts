import type { DB } from "@terragon/shared/db";
import {
  markDispatchIntentAcknowledged,
  markDispatchIntentFailed,
  getDispatchIntentByRunId,
} from "@terragon/shared/delivery-loop/store/dispatch-intent-store";
import {
  updateDispatchIntent,
  buildDispatchIntentId,
  getActiveDispatchIntent,
} from "./dispatch-intent";
import { evaluateRetryDecision, resetRetryCounter } from "./retry-policy";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout before a dispatched intent is considered timed out. */
export const DEFAULT_ACK_TIMEOUT_MS = 90_000; // 90 seconds — allows Docker cold starts

// ---------------------------------------------------------------------------
// handleAckReceived
// ---------------------------------------------------------------------------

/**
 * Called when the first daemon event for a given runId arrives (v2 seq starts
 * at 0, so this must be status-based and idempotent rather than seq-based).
 *
 * 1. Updates the Redis dispatch intent to "acknowledged" (real-time tracking).
 * 2. Updates the DB dispatch intent to "acknowledged" (durable record).
 * 3. Resets the retry counter for this thread chat (successful dispatch clears
 *    stale retry state).
 */
export async function handleAckReceived({
  db,
  runId,
  loopId,
  threadChatId,
}: {
  db: DB;
  runId: string;
  loopId: string;
  threadChatId: string;
}): Promise<void> {
  const intentId = buildDispatchIntentId(loopId, runId);
  const [activeIntent, dbTransitioned] = await Promise.all([
    getActiveDispatchIntent(threadChatId),
    markDispatchIntentAcknowledged(db, runId),
  ]);

  const shouldUpdateRealtimeIntent =
    activeIntent?.id === intentId &&
    activeIntent.runId === runId &&
    (activeIntent.status === "dispatched" ||
      activeIntent.status === "prepared");
  if (shouldUpdateRealtimeIntent) {
    await updateDispatchIntent(intentId, threadChatId, {
      status: "acknowledged",
    });
  }

  if (dbTransitioned || shouldUpdateRealtimeIntent) {
    await resetRetryCounter(threadChatId);
  }
}

// ---------------------------------------------------------------------------
// handleAckTimeout
// ---------------------------------------------------------------------------

export type AckTimeoutOutcome = {
  shouldRetry: boolean;
  action: string;
  attempt: number;
};

/**
 * Called when a dispatch intent has been in "dispatched" status past the
 * ack timeout window without receiving a daemon event.
 *
 * 1. Marks the intent as failed with `dispatch_ack_timeout`.
 * 2. Evaluates the retry policy to decide next action.
 *
 * The retry policy maps `dispatch_ack_timeout` → `retry_same_intent`,
 * meaning the caller should rerun prepare (sandbox health check, new
 * credentials) and re-dispatch, not just resend the socket message.
 */
export async function handleAckTimeout({
  db,
  runId,
  threadChatId,
  timeoutMs = DEFAULT_ACK_TIMEOUT_MS,
}: {
  db: DB;
  runId: string;
  threadChatId: string;
  timeoutMs?: number;
}): Promise<AckTimeoutOutcome> {
  await markDispatchIntentFailed(
    db,
    runId,
    "dispatch_ack_timeout",
    `No daemon event received within ${timeoutMs}ms of dispatch`,
  );

  const decision = await evaluateRetryDecision({
    threadChatId,
    failureCategory: "dispatch_ack_timeout",
  });

  if (decision.shouldRetry) {
    console.log("[ack-lifecycle] dispatch ack timed out, will retry", {
      runId,
      threadChatId,
      attempt: decision.attempt,
      action: decision.action,
      backoffMs: decision.backoffMs,
    });
  } else {
    console.warn(
      "[ack-lifecycle] dispatch ack timed out, retry budget exhausted",
      {
        runId,
        threadChatId,
        reason: decision.reason,
        attempt: decision.attempt,
      },
    );
  }

  return {
    shouldRetry: decision.shouldRetry,
    action: decision.action,
    attempt: decision.attempt,
  };
}

// ---------------------------------------------------------------------------
// startAckTimeout
// ---------------------------------------------------------------------------

/**
 * Schedules an ack timeout check for a dispatch intent. After `timeoutMs`,
 * checks if the intent is still in "dispatched" status. If so, calls
 * `handleAckTimeout` to classify and potentially retry.
 *
 * This is a best-effort in-process timer. The cron sweep in
 * `ack-timeout.ts` provides a durable fallback for cases where the
 * process restarts before the timer fires.
 *
 * Returns a cleanup function to cancel the timeout (e.g., if ack arrives
 * before the timer fires, though this is optional since handleAckTimeout
 * is idempotent against already-acknowledged intents).
 */
export function startAckTimeout({
  db,
  runId,
  loopId,
  threadChatId,
  userId,
  threadId,
  timeoutMs = DEFAULT_ACK_TIMEOUT_MS,
}: {
  db: DB;
  runId: string;
  loopId: string;
  threadChatId: string;
  userId?: string;
  threadId?: string;
  timeoutMs?: number;
}): () => void {
  const timer = setTimeout(async () => {
    try {
      // Check DB to see if intent was already acknowledged or completed
      const intent = await getDispatchIntentByRunId(db, runId);
      if (!intent) return;
      if (intent.status !== "dispatched") return; // Already acked/failed/completed

      const outcome = await handleAckTimeout({
        db,
        runId,
        threadChatId,
        timeoutMs,
      });

      if (outcome.shouldRetry) {
        try {
          const { appendSignalToInbox } = await import(
            "@terragon/shared/delivery-loop/store/signal-inbox-store"
          );
          const { runCoordinatorTick } = await import("./coordinator/tick");
          await appendSignalToInbox({
            db,
            loopId,
            causeType: "timer_dispatch_ack_expired",
            payload: {
              kind: "dispatch_ack_expired",
              consecutiveFailures: outcome.attempt,
            },
            canonicalCauseId: `ack-timeout-${runId}`,
          });
          await runCoordinatorTick({
            db,
            workflowId:
              loopId as import("@terragon/shared/delivery-loop/domain/workflow").WorkflowId,
            correlationId:
              `ack-timeout-timer-${runId}` as import("@terragon/shared/delivery-loop/domain/workflow").CorrelationId,
            loopId,
          });
        } catch (retryErr) {
          console.error("[ack-lifecycle] failed to signal ack-expired retry", {
            runId,
            loopId,
            threadChatId,
            error: retryErr,
          });
        }
      } else if (!outcome.shouldRetry) {
        console.warn(
          "[ack-lifecycle] ack timeout retry budget exhausted, no retry scheduled",
          {
            runId,
            threadChatId,
            attempt: outcome.attempt,
          },
        );
      }
    } catch (error) {
      console.error("[ack-lifecycle] startAckTimeout handler failed", {
        runId,
        loopId,
        threadChatId,
        error,
      });
    }
  }, timeoutMs);

  // Don't block process exit
  if (timer.unref) {
    timer.unref();
  }

  return () => clearTimeout(timer);
}
