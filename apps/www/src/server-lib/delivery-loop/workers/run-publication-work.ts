import type { DB } from "@terragon/shared/db";
import {
  completeWorkItem,
  failWorkItem,
  supersedePendingWorkItems,
} from "@terragon/shared/delivery-loop/store/work-queue-store";

export type PublicationWorkPayload = {
  target: { kind: string };
  workflowState: string;
};

/**
 * Execute a publication work item: check for superseded publications,
 * then format and publish to the target. Actual GitHub integration is
 * wired during Phase 7 migration.
 */
export async function runPublicationWork(params: {
  db: DB;
  workItemId: string;
  claimToken: string;
  workflowId: string;
  payload: PublicationWorkPayload;
}): Promise<void> {
  try {
    // 1. Supersede older pending publications for the same target
    await supersedePendingWorkItems({
      db: params.db,
      workflowId: params.workflowId,
      kind: "publication",
      excludeItemId: params.workItemId,
    });

    // 2. Format and publish to target (GitHub comment, check run, etc.)
    // Placeholder: actual publication integration during Phase 7

    // 3. Complete work item
    await completeWorkItem({
      db: params.db,
      workItemId: params.workItemId,
      claimToken: params.claimToken,
    });
  } catch (err) {
    // 4. On failure: fail work item with retry
    const retryAt = new Date(Date.now() + 15_000); // 15s backoff
    await failWorkItem({
      db: params.db,
      workItemId: params.workItemId,
      claimToken: params.claimToken,
      errorCode: "publication_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      retryAt,
    });
  }
}
