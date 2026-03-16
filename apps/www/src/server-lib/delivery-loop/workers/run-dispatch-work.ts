import type { DB } from "@terragon/shared/db";
import type { DBUserMessage } from "@terragon/shared/db/db-message";
import type { ExecutionClass } from "@terragon/shared/delivery-loop/domain/workflow";
import {
  completeWorkItem,
  failWorkItem,
} from "@terragon/shared/delivery-loop/store/work-queue-store";
import { getWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import { updateThreadChat } from "@terragon/shared/model/threads";
import { and, eq, ne, desc } from "drizzle-orm";
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
import { stringifyError } from "./resolve-loop";

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

    // Guard: workflow moved to a non-dispatchable state between enqueue and execution
    const DISPATCHABLE_KINDS = new Set(["planning", "implementing", "gating"]);
    if (!DISPATCHABLE_KINDS.has(workflow.kind)) {
      await completeWorkItem({
        db: params.db,
        workItemId: params.workItemId,
        claimToken: params.claimToken,
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
        : // Prefer an active (non-complete) chat for this thread so we
          // dispatch into the right chat on multi-chat threads. Falls back
          // to most-recent if all chats are complete.
          params.db.query.threadChat
            .findFirst({
              where: and(
                eq(schema.threadChat.threadId, workflow.threadId),
                ne(schema.threadChat.status, "complete"),
              ),
              orderBy: [desc(schema.threadChat.createdAt)],
            })
            .then(
              (active) =>
                active ??
                params.db.query.threadChat.findFirst({
                  where: eq(schema.threadChat.threadId, workflow.threadId),
                  orderBy: [desc(schema.threadChat.createdAt)],
                }),
            ),
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
      workflow.kind === "gating"
        ? (`${params.payload.gate ?? "review"}_gate` as const)
        : "implementing";

    // Guard: stale gate dispatch — payload gate no longer matches current workflow gate
    const stateJson = workflow.stateJson as Record<string, unknown> | null;
    const currentGateKind =
      stateJson && typeof stateJson === "object"
        ? (stateJson as { gate?: { kind?: string } }).gate?.kind
        : undefined;
    if (
      workflow.kind === "gating" &&
      params.payload.gate &&
      currentGateKind !== params.payload.gate
    ) {
      await completeWorkItem({
        db: params.db,
        workItemId: params.workItemId,
        claimToken: params.claimToken,
      });
      return;
    }

    // 5. Create dispatch intent in Redis. This is the handoff point — the
    //    follow-up queue processor reads this intent to launch the sandbox
    //    and send the daemon message (see dispatch lifecycle in docstring).
    let runId: string = randomUUID();
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
      gate: params.payload.gate,
      headSha: params.payload.headSha,
    };

    try {
      await createDispatchIntent(intentParams);
    } catch (intentErr) {
      if (
        intentErr instanceof Error &&
        intentErr.message.includes("active intent")
      ) {
        // A prior attempt created the Redis intent. Check its status to
        // decide whether to re-attempt follow-up or complete immediately.
        const { getActiveDispatchIntent } = await import("../dispatch-intent");
        const existingIntent = await getActiveDispatchIntent(threadChat.id);
        const existingStatus = existingIntent?.status ?? "prepared";

        if (existingStatus !== "prepared") {
          // Intent was dispatched/completed/failed — the run was handed off.
          // Complete the work item; the ack timeout monitors liveness.
          await completeWorkItem({
            db: params.db,
            workItemId: params.workItemId,
            claimToken: params.claimToken,
          });
          return;
        }
        // Status is "prepared" — the prior attempt created the intent but
        // crashed before triggering the follow-up queue. Fall through to
        // attempt follow-up processing below. Use the existing intent's
        // runId for ack timeout tracking.
        runId = existingIntent?.runId ?? runId;
      } else {
        throw intentErr;
      }
    }

    // 6. Persist durable dispatch intent in the DB so the ack timeout
    //    handler and cron sweep can find it. The Redis intent is for
    //    real-time tracking; the DB intent is for durable recovery.
    //    Always attempt — on collision recovery the prior attempt may have
    //    crashed before the DB write. createDbDispatchIntent has a unique
    //    constraint so duplicates fail safely.
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
      // Non-fatal: Redis intent + cron sweep will handle recovery.
      // On collision recovery this will hit the unique constraint — expected.
      console.warn("[dispatch-worker] durable dispatch intent write failed", {
        workflowId: params.payload.workflowId,
        runId,
        error: dbIntentErr,
      });
    }

    // 6b. Queue a dispatch continuation message so the follow-up queue
    //     has something to process. Always attempt — on collision recovery
    //     the prior attempt may have crashed before writing the message.
    //     An extra queued message is benign; a missing one stalls the loop.
    let continuationText = `Continue ${targetPhase === "implementing" ? "implementing" : "gate check"}.`;

    // For implementing dispatches, include plan context so the daemon knows what to implement
    if (targetPhase === "implementing" && loop) {
      try {
        const { getLatestAcceptedArtifact } = await import(
          "@terragon/shared/model/delivery-loop/artifacts"
        );
        const artifact = await getLatestAcceptedArtifact({
          db: params.db,
          loopId: loop.id,
          phase: "planning",
          includeApprovedForPlanning: true,
        });
        if (artifact?.payload) {
          const payload = artifact.payload as { planText?: string };
          if (payload.planText) {
            continuationText = `Continue implementing the approved plan.\n\nFor reference, here is the approved plan:\n${payload.planText}`;
          }
        }
      } catch (err) {
        console.warn(
          "[dispatch-worker] failed to load plan artifact for continuation message",
          {
            loopId: loop.id,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    const dispatchMessage: DBUserMessage = {
      type: "user",
      model: null,
      timestamp: new Date().toISOString(),
      parts: [
        {
          type: "text",
          text: continuationText,
        },
      ],
    };
    await updateThreadChat({
      db: params.db,
      userId: loop.userId,
      threadId: workflow.threadId,
      threadChatId: threadChat.id,
      updates: {
        appendQueuedMessages: [dispatchMessage],
      },
    });

    // 6c. Trigger the follow-up queue to actually launch the run.
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
      // Treat stale_cas_busy as a successful handoff — the chat is
      // already active from a concurrent dispatch, so the run was launched.
      followUpProcessed =
        followUpResult.processed || followUpResult.reason === "stale_cas_busy";
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

    // Arm ack watchdog whenever a run was actually launched.
    if (followUpProcessed) {
      try {
        await startAckTimeout({
          db: params.db,
          runId,
          loopId: loop.id,
          threadChatId: threadChat.id,
        });
      } catch (ackErr) {
        console.warn(
          "[dispatch-worker] startAckTimeout failed, run may lack watchdog",
          {
            runId,
            error: ackErr instanceof Error ? ackErr.message : String(ackErr),
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
      errorMessage: stringifyError(err),
      retryAt,
    });
  }
}
