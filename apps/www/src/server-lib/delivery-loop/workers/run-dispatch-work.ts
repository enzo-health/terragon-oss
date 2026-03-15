import type { DB } from "@terragon/shared/db";
import type { ExecutionClass } from "@terragon/shared/delivery-loop/domain/workflow";
import {
  completeWorkItem,
  failWorkItem,
} from "@terragon/shared/delivery-loop/store/work-queue-store";
import { eq, desc } from "drizzle-orm";
import * as schema from "@terragon/shared/db/schema";
import { randomUUID } from "node:crypto";
import {
  createDispatchIntent,
  type CreateDispatchIntentParams,
} from "../dispatch-intent";
import { startAckTimeout } from "../ack-lifecycle";

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

    // 2. Resolve loop — prefer payload.loopId, fall back to threadId lookup
    let loop;
    if (params.payload.loopId) {
      loop = await params.db.query.sdlcLoop.findFirst({
        where: eq(schema.sdlcLoop.id, params.payload.loopId),
      });
    } else {
      loop = await params.db.query.sdlcLoop.findFirst({
        where: eq(schema.sdlcLoop.threadId, workflow.threadId),
        orderBy: [desc(schema.sdlcLoop.createdAt)],
      });
    }
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

    // 3. Resolve threadChat — prefer payload.threadChatId, fall back to latest
    let threadChat;
    if (params.payload.threadChatId) {
      threadChat = await params.db.query.threadChat.findFirst({
        where: eq(schema.threadChat.id, params.payload.threadChatId),
      });
    } else {
      threadChat = await params.db.query.threadChat.findFirst({
        where: eq(schema.threadChat.threadId, workflow.threadId),
        orderBy: [desc(schema.threadChat.createdAt)],
      });
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

    try {
      await createDispatchIntent(intentParams);
    } catch (intentErr) {
      // If an active intent already exists, that's OK — don't fail the work item
      if (
        intentErr instanceof Error &&
        intentErr.message.includes("active intent")
      ) {
        await completeWorkItem({
          db: params.db,
          workItemId: params.workItemId,
          claimToken: params.claimToken,
        });
        return;
      }
      throw intentErr;
    }

    // 6. Start ack timeout — if the daemon doesn't ack within the deadline,
    //    a timer signal is written to the inbox so the coordinator retries.
    startAckTimeout({
      db: params.db,
      runId,
      loopId: loop.id,
      threadChatId: threadChat.id,
    });

    // 6.5. Trigger the follow-up queue to actually launch the run.
    // The follow-up queue handles sandbox creation, daemon messaging,
    // and all the infrastructure needed to start an agent run.
    try {
      const { maybeProcessFollowUpQueue } = await import(
        "@/server-lib/process-follow-up-queue"
      );
      await maybeProcessFollowUpQueue({
        userId: loop.userId,
        threadId: workflow.threadId,
        threadChatId: threadChat.id,
      });
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

    // 7. Complete work item — dispatch worker's job is done; the follow-up
    //    queue and ack timeout handle the rest asynchronously.
    await completeWorkItem({
      db: params.db,
      workItemId: params.workItemId,
      claimToken: params.claimToken,
    });
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
