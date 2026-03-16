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
  retryDepth?: number;
};

const MAX_RETRY_DEPTH = 3;

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
    // 0. Guard against infinite retry loops
    const retryDepth = params.payload.retryDepth ?? 0;
    if (retryDepth >= MAX_RETRY_DEPTH) {
      console.warn(
        "[retry-worker] max retry depth reached, completing without re-enqueue",
        {
          workflowId: params.payload.workflowId,
          kind: params.payload.kind,
          retryDepth,
        },
      );
      await completeWorkItem({
        db: params.db,
        workItemId: params.workItemId,
        claimToken: params.claimToken,
      });
      return;
    }

    // 1. Re-enqueue the original work item with backoff
    const scheduledAt = params.payload.dueAt
      ? new Date(params.payload.dueAt)
      : new Date(Date.now() + 60_000); // Default 1min backoff

    await enqueueWorkItem({
      db: params.db,
      workflowId: params.payload.workflowId,
      correlationId: params.correlationId,
      kind: params.payload.kind,
      payloadJson: {
        ...params.payload.originalPayload,
        retryDepth: retryDepth + 1,
      },
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
      retryAt: new Date(Date.now() + 30_000), // 30s backoff to prevent tight loops
    });
  }
}
