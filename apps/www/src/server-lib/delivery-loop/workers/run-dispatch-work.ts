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
  gate?: string;
  headSha?: string;
};

/**
 * Execute a dispatch work item: load the workflow, look up the sdlcLoop
 * and threadChat, create a dispatch intent, and start an ack timeout.
 *
 * The actual daemon dispatch happens through the follow-up queue — the
 * worker's job is to prepare the intent and mark the work item completed.
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

    // 2. Look up sdlcLoop by threadId to get loopId, repoFullName
    const loop = await params.db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.threadId, workflow.threadId),
    });
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

    // 3. Look up the latest threadChat to get threadChatId
    const threadChat = await params.db.query.threadChat.findFirst({
      where: eq(schema.threadChat.threadId, workflow.threadId),
      orderBy: [desc(schema.threadChat.createdAt)],
    });
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

    // 5. Create dispatch intent (Redis-backed real-time tracking)
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

    // 6. Start ack timeout (best-effort in-process timer)
    startAckTimeout({
      db: params.db,
      runId,
      loopId: loop.id,
      threadChatId: threadChat.id,
    });

    // 7. Complete work item
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
