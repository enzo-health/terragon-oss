import type { DB } from "@terragon/shared/db";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";
import {
  completeWorkItem,
  failWorkItem,
} from "@terragon/shared/delivery-loop/store/work-queue-store";

export type BabysitWorkPayload = {
  workflowId: string;
};

/**
 * Execute a babysit work item: check whether all babysitting gates
 * pass for the current head SHA. If they do, append a babysit_passed
 * signal; otherwise append babysit_blocked.
 *
 * Actual babysit evaluation (CI gate status, review thread resolution,
 * deep/carmack review findings) is wired during Phase 7 migration,
 * referencing evaluateBabysitCompletionForHead from signal-inbox-core.
 */
export async function runBabysitWork(params: {
  db: DB;
  workItemId: string;
  claimToken: string;
  payload: BabysitWorkPayload;
}): Promise<void> {
  try {
    const workflowId = params.payload.workflowId as WorkflowId;

    // 1. Load workflow
    const { getWorkflow } = await import(
      "@terragon/shared/delivery-loop/store/workflow-store"
    );
    const workflow = await getWorkflow({ db: params.db, workflowId });
    if (!workflow) {
      await completeWorkItem({
        db: params.db,
        workItemId: params.workItemId,
        claimToken: params.claimToken,
      });
      return;
    }

    // 2. If not in babysitting state, complete work item (stale)
    if (workflow.kind !== "babysitting") {
      await completeWorkItem({
        db: params.db,
        workItemId: params.workItemId,
        claimToken: params.claimToken,
      });
      return;
    }

    // 3. Run babysit recheck logic
    // Placeholder: actual babysit evaluation during Phase 7
    // Will check:
    //   - CI gate status for current head SHA
    //   - Review thread resolution
    //   - Deep/carmack review findings
    // Then append babysit_passed or babysit_blocked signal

    // 4. Complete work item
    await completeWorkItem({
      db: params.db,
      workItemId: params.workItemId,
      claimToken: params.claimToken,
    });
  } catch (err) {
    const retryAt = new Date(Date.now() + 60_000); // 1min backoff
    await failWorkItem({
      db: params.db,
      workItemId: params.workItemId,
      claimToken: params.claimToken,
      errorCode: "babysit_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      retryAt,
    });
  }
}
