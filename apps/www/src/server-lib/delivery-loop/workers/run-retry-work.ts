import type { DB } from "@terragon/shared/db";
import {
  enqueueWorkItem,
  completeWorkItem,
  failWorkItem,
} from "@terragon/shared/delivery-loop/store/work-queue-store";

export type RetryWorkPayload = {
  kind: string;
  workflowId: string;
  originalPayload: Record<string, unknown>;
  dispatchId?: string;
  operation?: string;
  dueAt?: string;
};

/**
 * Execute a retry work item: re-enqueue the original work item
 * with exponential backoff. Actual retry logic is refined during
 * Phase 7 migration.
 */
export async function runRetryWork(params: {
  db: DB;
  workItemId: string;
  claimToken: string;
  correlationId: string;
  payload: RetryWorkPayload;
}): Promise<void> {
  try {
    // 1. Re-enqueue the original work item with backoff
    const scheduledAt = params.payload.dueAt
      ? new Date(params.payload.dueAt)
      : new Date(Date.now() + 60_000); // Default 1min backoff

    await enqueueWorkItem({
      db: params.db,
      workflowId: params.payload.workflowId,
      correlationId: params.correlationId,
      kind: params.payload.kind,
      payloadJson: params.payload.originalPayload,
      scheduledAt,
    });

    // 2. Complete this retry work item
    await completeWorkItem({
      db: params.db,
      workItemId: params.workItemId,
      claimToken: params.claimToken,
    });
  } catch (err) {
    await failWorkItem({
      db: params.db,
      workItemId: params.workItemId,
      claimToken: params.claimToken,
      errorCode: "retry_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}
