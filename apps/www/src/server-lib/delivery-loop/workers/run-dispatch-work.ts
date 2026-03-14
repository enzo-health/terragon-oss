import type { DB } from "@terragon/shared/db";
import type { ExecutionClass } from "@terragon/shared/delivery-loop/domain/workflow";
import {
  completeWorkItem,
  failWorkItem,
} from "@terragon/shared/delivery-loop/store/work-queue-store";

export type DispatchWorkPayload = {
  executionClass: ExecutionClass;
  workflowId: string;
  gate?: string;
  headSha?: string;
};

/**
 * Execute a dispatch work item: load the workflow, determine the dispatch
 * target, and execute the dispatch. Actual sandbox/daemon integration is
 * wired during Phase 7 migration.
 */
export async function runDispatchWork(params: {
  db: DB;
  workItemId: string;
  claimToken: string;
  payload: DispatchWorkPayload;
}): Promise<void> {
  try {
    // 1. Load workflow from workflow-store
    const { getWorkflow } = await import(
      "@terragon/shared/delivery-loop/store/workflow-store"
    );
    const workflow = await getWorkflow({
      db: params.db,
      workflowId: params.payload.workflowId,
    });
    if (!workflow) {
      await failWorkItem({
        db: params.db,
        workItemId: params.workItemId,
        claimToken: params.claimToken,
        errorCode: "workflow_not_found",
        errorMessage: `Workflow ${params.payload.workflowId} not found`,
      });
      return;
    }

    // 2. Determine dispatch target (agent type, sandbox)
    // 3. Execute dispatch
    // Placeholder: actual dispatch integrates with existing
    // sandbox/daemon infrastructure (Phase 7)

    // 4. Complete work item
    await completeWorkItem({
      db: params.db,
      workItemId: params.workItemId,
      claimToken: params.claimToken,
    });
  } catch (err) {
    // 5. On failure: fail work item with retry
    const retryAt = new Date(Date.now() + 30_000); // 30s backoff
    await failWorkItem({
      db: params.db,
      workItemId: params.workItemId,
      claimToken: params.claimToken,
      errorCode: "dispatch_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      retryAt,
    });
  }
}
