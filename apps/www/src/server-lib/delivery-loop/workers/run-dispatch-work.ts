import type { DB } from "@terragon/shared/db";
import type { ExecutionClass } from "@terragon/shared/delivery-loop/domain/workflow";
import {
  completeWorkItem,
  failWorkItem,
} from "@terragon/shared/delivery-loop/store/work-queue-store";
import { getWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import { eq, desc } from "drizzle-orm";
import * as schema from "@terragon/shared/db/schema";
import { randomUUID } from "node:crypto";
import {
  createDispatchIntent,
  type CreateDispatchIntentParams,
} from "../dispatch-intent";
import { startAckTimeout } from "../ack-lifecycle";
import {
  createDispatchIntent as createDbDispatchIntent,
  markDispatchIntentDispatched,
} from "@terragon/shared/model/delivery-loop";

export type DispatchWorkPayload = {
  executionClass: ExecutionClass;
  workflowId: string;
  loopId?: string;
  threadChatId?: string;
  gate?: string;
  headSha?: string;
};

/**
 * Execute a dispatch work item — the first stage of a two-phase dispatch lifecycle.
 *
 * ## Dispatch lifecycle
 *
 * 1. **This worker** resolves the workflow/thread/loop context, then writes a
 *    Redis dispatch intent via `createDispatchIntent` (see `dispatch-intent.ts`).
 *    It does NOT directly create a sandbox or send a daemon message.
 *
 * 2. **The follow-up queue processor** (`queueFollowUp` / `processFollowUp`)
 *    picks up the `threadChatId` associated with the intent, creates or resumes
 *    a sandbox, and sends the actual daemon message that starts the agent run.
 *
 * 3. **The ack timeout** (started here via `startAckTimeout`) monitors whether
 *    the daemon acknowledges the dispatch within a deadline. If the timeout
 *    expires without an ack, a timer signal is appended to the signal inbox
 *    so the coordinator can schedule a retry on the next tick.
 *
 * This separation keeps the dispatch worker fast and idempotent — it only
 * touches Redis and the DB, while sandbox/daemon orchestration stays in
 * the follow-up queue's existing infra.
 */
export async function runDispatchWork(params: {
  db: DB;
  workItemId: string;
  claimToken: string;
  payload: DispatchWorkPayload;
}): Promise<void> {
  try {
    // 1. Load workflow from workflow-store
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

    // 2 & 3. Resolve loop + threadChat in parallel (both depend on threadId only)
    const [loop, threadChat] = await Promise.all([
      params.payload.loopId
        ? params.db.query.sdlcLoop.findFirst({
            where: eq(schema.sdlcLoop.id, params.payload.loopId),
          })
        : params.db.query.sdlcLoop.findFirst({
            where: eq(schema.sdlcLoop.threadId, workflow.threadId),
            orderBy: [desc(schema.sdlcLoop.createdAt)],
          }),
      params.payload.threadChatId
        ? params.db.query.threadChat.findFirst({
            where: eq(schema.threadChat.id, params.payload.threadChatId),
          })
        : params.db.query.threadChat.findFirst({
            where: eq(schema.threadChat.threadId, workflow.threadId),
            orderBy: [desc(schema.threadChat.createdAt)],
          }),
    ]);
    if (!loop) {
      await failWorkItem({
        db: params.db,
        workItemId: params.workItemId,
        claimToken: params.claimToken,
        errorCode: "loop_not_found",
        errorMessage: `No sdlcLoop found for threadId ${workflow.threadId}`,
      });
      return;
    }
    if (!threadChat) {
      await failWorkItem({
        db: params.db,
        workItemId: params.workItemId,
        claimToken: params.claimToken,
        errorCode: "thread_chat_not_found",
        errorMessage: `No threadChat found for threadId ${workflow.threadId}`,
      });
      return;
    }

    // 4. Determine target phase from workflow state
    const targetPhase =
      workflow.kind === "planning"
        ? "planning"
        : workflow.kind === "gating"
          ? "reviewing"
          : "implementing";

    // 5. Create dispatch intent in Redis. This is the handoff point — the
    //    follow-up queue processor reads this intent to launch the sandbox
    //    and send the daemon message (see dispatch lifecycle in docstring).
    const runId = randomUUID();
    const intentParams: CreateDispatchIntentParams = {
      loopId: loop.id,
      threadId: workflow.threadId,
      threadChatId: threadChat.id,
      targetPhase: targetPhase as CreateDispatchIntentParams["targetPhase"],
      selectedAgent: "claudeCode",
      executionClass: params.payload.executionClass,
      dispatchMechanism: "self_dispatch",
      runId,
      maxRetries: 3,
    };

    let intentAlreadyActive = false;
    try {
      await createDispatchIntent(intentParams);
    } catch (intentErr) {
      // If an active intent already exists (e.g. retry after follow_up_not_processed),
      // skip creating a new one but still proceed to trigger the follow-up queue.
      // Completing early here would leave the workflow stuck with no run launched.
      if (
        intentErr instanceof Error &&
        intentErr.message.includes("active intent")
      ) {
        intentAlreadyActive = true;
      } else {
        throw intentErr;
      }
    }

    // 6. Persist durable dispatch intent in the DB so the ack timeout
    //    handler and cron sweep can find it. The Redis intent is for
    //    real-time tracking; the DB intent is for durable recovery.
    //    Skip if we're reusing an already-active intent from a prior attempt.
    if (!intentAlreadyActive)
      try {
        await createDbDispatchIntent(params.db, {
          loopId: loop.id,
          threadId: workflow.threadId,
          threadChatId: threadChat.id,
          runId,
          targetPhase: targetPhase as CreateDispatchIntentParams["targetPhase"],
          selectedAgent: "claudeCode",
          executionClass: params.payload.executionClass,
          dispatchMechanism: "self_dispatch",
        });
        await markDispatchIntentDispatched(params.db, runId);
      } catch (dbIntentErr) {
        // Non-fatal: Redis intent + cron sweep will handle recovery
        console.warn("[dispatch-worker] durable dispatch intent write failed", {
          workflowId: params.payload.workflowId,
          runId,
          error: dbIntentErr,
        });
      }

    // 6b. Trigger the follow-up queue to actually launch the run.
    // Only arm ack timeout if the follow-up queue actually started processing,
    // otherwise we'd create phantom dispatches that inevitably time out.
    let followUpProcessed = false;
    try {
      const { maybeProcessFollowUpQueue } = await import(
        "@/server-lib/process-follow-up-queue"
      );
      const followUpResult = await maybeProcessFollowUpQueue({
        userId: loop.userId,
        threadId: workflow.threadId,
        threadChatId: threadChat.id,
      });
      followUpProcessed = followUpResult.processed;
    } catch (followUpErr) {
      // Non-fatal: the cron job will pick up pending follow-ups
      console.warn(
        "[dispatch-worker] maybeProcessFollowUpQueue failed, cron will retry",
        {
          workflowId: params.payload.workflowId,
          error: followUpErr,
        },
      );
    }

    // Only start ack timeout if a run was actually launched — otherwise
    // the timeout fires on a phantom dispatch and triggers false retries.
    if (followUpProcessed) {
      startAckTimeout({
        db: params.db,
        runId,
        loopId: loop.id,
        threadChatId: threadChat.id,
      });

      // 7. Complete work item — dispatch worker's job is done; the follow-up
      //    queue and ack timeout handle the rest asynchronously.
      await completeWorkItem({
        db: params.db,
        workItemId: params.workItemId,
        claimToken: params.claimToken,
      });
    } else {
      // Follow-up queue didn't launch a run — fail the work item so it
      // gets retried. Otherwise the workflow stays in implementing/gating
      // with no daemon run ever started.
      const retryAt = new Date(Date.now() + 15_000); // 15s backoff
      await failWorkItem({
        db: params.db,
        workItemId: params.workItemId,
        claimToken: params.claimToken,
        errorCode: "follow_up_not_processed",
        errorMessage: "Follow-up queue did not start a run",
        retryAt,
      });
    }
  } catch (err) {
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
