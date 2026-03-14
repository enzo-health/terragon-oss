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
    //
    // TODO(Phase 7 wiring): Integrate with existing dispatch infrastructure:
    //
    // - createDispatchIntent() from
    //   apps/www/src/server-lib/delivery-loop/dispatch-intent.ts
    //   Creates a Redis-backed dispatch intent for real-time tracking.
    //   Needs: loopId, threadId, threadChatId, targetPhase, selectedAgent,
    //          executionClass, dispatchMechanism, runId, maxRetries
    //
    // - handleAckReceived() from
    //   apps/www/src/server-lib/delivery-loop/ack-lifecycle.ts
    //   Called when the first daemon event arrives to mark intent as acknowledged.
    //
    // - startAckTimeout() from
    //   apps/www/src/server-lib/delivery-loop/ack-lifecycle.ts
    //   Schedules an ack timeout check; calls handleAckTimeout on expiry.
    //
    // - The v2 DispatchSubState (workflow.dispatch) tracks queued/sent/acked/failed
    //   status and should be kept in sync with the Redis dispatch intent.
    //
    // Flow:
    //   a) Read the sdlcLoop to get threadId, threadChatId, repoFullName
    //   b) Create dispatch intent via createDispatchIntent()
    //   c) Prepare sandbox / credentials
    //   d) Send dispatch to daemon
    //   e) Start ack timeout via startAckTimeout()
    //

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
