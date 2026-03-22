import type { DB } from "@terragon/shared/db";
import type { DBUserMessage } from "@terragon/shared/db/db-message";
import type { ExecutionClass } from "@terragon/shared/delivery-loop/domain/workflow";
import { toSelectedAgent } from "@terragon/shared/delivery-loop/domain/dispatch-types";
import {
  completeWorkItem,
  failWorkItem,
} from "@terragon/shared/delivery-loop/store/work-queue-store";
import { getWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import { updateThreadChat } from "@terragon/shared/model/threads";
import { getLatestAgentRunContextForThreadChat } from "@terragon/shared/model/agent-run-context";
import { and, eq, ne, desc } from "drizzle-orm";
import * as schema from "@terragon/shared/db/schema";
import { randomUUID } from "node:crypto";
import {
  createDispatchIntent,
  type CreateDispatchIntentParams,
} from "../dispatch-intent";
import { DEFAULT_ACK_TIMEOUT_MS, startAckTimeout } from "../ack-lifecycle";
import {
  createDispatchIntent as createDbDispatchIntent,
  markDispatchIntentDispatched,
} from "@terragon/shared/delivery-loop/store/dispatch-intent-store";
import { appendEventAndAdvanceV3 } from "../v3/kernel";

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ACTIVE_AGENT_RUN_STATUSES = new Set([
  "pending",
  "dispatched",
  "processing",
]);

function getLatestUserPromptText(messages: unknown): string | null {
  if (!Array.isArray(messages)) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index] as
      | {
          type?: unknown;
          parts?: Array<{ type?: unknown; text?: unknown }>;
        }
      | undefined;
    if (
      !candidate ||
      candidate.type !== "user" ||
      !Array.isArray(candidate.parts)
    ) {
      continue;
    }
    const text = candidate.parts
      .filter((part): part is { type: "text"; text: string } => {
        return part?.type === "text" && typeof part.text === "string";
      })
      .map((part) => part.text.trim())
      .filter((part) => part.length > 0)
      .join("\n\n");
    if (text.length > 0) {
      return text;
    }
  }
  return null;
}

export type DispatchWorkPayload = {
  executionClass: ExecutionClass;
  workflowId: string;
  threadChatId?: string;
  gate?: string;
  headSha?: string;
  bootstrap?: boolean;
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
 * 3. **The ack timeout** is persisted as a v3 effect (`ack_timeout_check`)
 *    when the dispatch enters the active run state. The effect worker
 *    replays that timer durably, so the retry path does not depend on an
 *    in-process timeout callback.
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

    // 2. Resolve threadChat
    const threadChat = await (params.payload.threadChatId
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
          ));
    const effectiveLoopId = workflow.id;
    const effectiveUserId = workflow.userId;
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
    let activeRunIdForChat: string | null = null;
    try {
      const latestRunContext = await getLatestAgentRunContextForThreadChat({
        db: params.db,
        userId: effectiveUserId,
        threadId: workflow.threadId,
        threadChatId: threadChat.id,
      });
      if (
        latestRunContext &&
        ACTIVE_AGENT_RUN_STATUSES.has(latestRunContext.status)
      ) {
        activeRunIdForChat = latestRunContext.runId;
      }
    } catch (runContextErr) {
      console.warn("[dispatch-worker] failed to inspect latest run context", {
        workflowId: params.payload.workflowId,
        threadId: workflow.threadId,
        threadChatId: threadChat.id,
        error:
          runContextErr instanceof Error
            ? runContextErr.message
            : String(runContextErr),
      });
    }

    let runId: string = activeRunIdForChat ?? randomUUID();
    const intentParams: CreateDispatchIntentParams = {
      loopId: effectiveLoopId,
      threadId: workflow.threadId,
      threadChatId: threadChat.id,
      targetPhase: targetPhase as CreateDispatchIntentParams["targetPhase"],
      selectedAgent: toSelectedAgent(threadChat.agent),
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
        loopId: effectiveLoopId,
        threadId: workflow.threadId,
        threadChatId: threadChat.id,
        runId,
        targetPhase: targetPhase as CreateDispatchIntentParams["targetPhase"],
        selectedAgent: toSelectedAgent(threadChat.agent),
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

    let followUpProcessed = false;
    let followUpRetryScheduled = false;
    let inferredBusyLaunch = false;
    let inferredBusyRunIdResolved = false;
    let dispatchRunId = runId;
    if (activeRunIdForChat) {
      // The thread chat already has an active run. Do not enqueue a synthetic
      // "continue implementing" prompt — that can derail the existing run.
      // Instead, attach the workflow lifecycle to the active run deterministically.
      followUpProcessed = true;
      inferredBusyLaunch = true;
      inferredBusyRunIdResolved = true;
      dispatchRunId = activeRunIdForChat;
    } else if (params.payload.bootstrap) {
      // Initial thread creation already launches the first run. If we race
      // before run context persistence, avoid injecting an extra "continue"
      // user message and let this work item retry until the active run is visible.
      console.log(
        "[dispatch-worker] bootstrap dispatch waiting for active run context",
        {
          workflowId: params.payload.workflowId,
          threadId: workflow.threadId,
          threadChatId: threadChat.id,
        },
      );
    } else {
      // 6b. Queue a dispatch continuation message so the follow-up queue
      //     has something to process. Always attempt — on collision recovery
      //     the prior attempt may have crashed before writing the message.
      //     An extra queued message is benign; a missing one stalls the loop.
      const latestUserPrompt =
        getLatestUserPromptText(threadChat.messages) ??
        threadChat.title ??
        null;
      let continuationText =
        targetPhase === "implementing"
          ? [
              "Continue implementing the approved task.",
              latestUserPrompt
                ? `Original task request:\n${latestUserPrompt}`
                : "Original task request is unavailable; continue from prior context.",
            ].join("\n\n")
          : "Continue gate check.";

      // For implementing dispatches, include plan context so the daemon knows what to implement
      if (targetPhase === "implementing") {
        try {
          const { getLatestAcceptedArtifact } = await import(
            "@terragon/shared/delivery-loop/store/artifact-store"
          );
          const artifact = await getLatestAcceptedArtifact({
            db: params.db,
            loopId: effectiveLoopId,
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
              loopId: effectiveLoopId,
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
        userId: effectiveUserId,
        threadId: workflow.threadId,
        threadChatId: threadChat.id,
        updates: {
          appendQueuedMessages: [dispatchMessage],
        },
      });

      // 6c. Trigger the follow-up queue to actually launch the run.
      // Only arm ack timeout if the follow-up queue actually started processing,
      // otherwise we'd create phantom dispatches that inevitably time out.
      try {
        const { maybeProcessFollowUpQueue } = await import(
          "@/server-lib/process-follow-up-queue"
        );
        const followUpResult = await maybeProcessFollowUpQueue({
          userId: effectiveUserId,
          threadId: workflow.threadId,
          threadChatId: threadChat.id,
        });
        // Only treat the handoff as successful when a run was actually launched.
        followUpProcessed = followUpResult.dispatchLaunched;
        // Follow-up queue persisted a retry marker; do not burn dispatch work
        // attempts while the dedicated retry path is already armed.
        followUpRetryScheduled =
          followUpResult.reason === "dispatch_retry_scheduled";
        inferredBusyLaunch =
          followUpResult.reason === "stale_cas_busy" &&
          followUpResult.dispatchLaunched;
        if (inferredBusyLaunch) {
          try {
            const latestRunContext =
              await getLatestAgentRunContextForThreadChat({
                db: params.db,
                userId: effectiveUserId,
                threadId: workflow.threadId,
                threadChatId: threadChat.id,
              });
            if (
              latestRunContext &&
              ACTIVE_AGENT_RUN_STATUSES.has(latestRunContext.status)
            ) {
              dispatchRunId = latestRunContext.runId;
              inferredBusyRunIdResolved = true;
            }
          } catch (resolveRunErr) {
            console.warn(
              "[dispatch-worker] failed resolving busy run id from latest run context",
              {
                workflowId: params.payload.workflowId,
                threadId: workflow.threadId,
                threadChatId: threadChat.id,
                error:
                  resolveRunErr instanceof Error
                    ? resolveRunErr.message
                    : String(resolveRunErr),
              },
            );
          }
        }
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
    }

    // Arm ack watchdog whenever a run was actually launched.
    if (followUpProcessed || followUpRetryScheduled) {
      const ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS;
      if (!inferredBusyLaunch || inferredBusyRunIdResolved) {
        try {
          await appendEventAndAdvanceV3({
            db: params.db,
            workflowId: effectiveLoopId,
            source: "system",
            idempotencyKey: `dispatch-sent:${dispatchRunId}`,
            event: {
              type: "dispatch_sent",
              runId: dispatchRunId,
              ackDeadlineAt: new Date(Date.now() + ackTimeoutMs),
            },
          });
        } catch (v3Err) {
          console.warn("[dispatch-worker] failed to append v3 dispatch_sent", {
            workflowId: effectiveLoopId,
            runId: dispatchRunId,
            error: v3Err instanceof Error ? v3Err.message : String(v3Err),
          });
          try {
            await startAckTimeout({
              db: params.db,
              runId: dispatchRunId,
              loopId: effectiveLoopId,
              threadChatId: threadChat.id,
              userId: effectiveUserId,
              threadId: workflow.threadId,
            });
          } catch (ackErr) {
            console.warn("[dispatch-worker] startAckTimeout fallback failed", {
              workflowId: effectiveLoopId,
              runId,
              error: ackErr instanceof Error ? ackErr.message : String(ackErr),
            });
          }
        }
      } else {
        console.log(
          "[dispatch-worker] inferred launch via stale busy CAS; skipping dispatch_sent due to unresolved active run id",
          {
            workflowId: effectiveLoopId,
            threadId: workflow.threadId,
            threadChatId: threadChat.id,
          },
        );
      }

      // 7. Complete work item — dispatch worker's job is done; the follow-up
      //    queue and durable effect ledger handle the rest asynchronously.
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
        errorMessage: "Follow-up queue did not start a run or schedule a retry",
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
