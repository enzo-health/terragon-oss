import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { getScheduledThreadChatsDueToRun } from "@terragon/shared/model/threads";
import { internalPOST } from "@/server-lib/internal-request";
import type {
  BabysitWorkPayload,
  DispatchWorkPayload,
  PublicationWorkPayload,
  RetrospectiveWorkPayload,
  RetryWorkPayload,
} from "@/server-lib/delivery-loop/workers";
import type {
  CorrelationId,
  WorkflowId,
} from "@terragon/shared/delivery-loop/domain/workflow";

const BATCH_SIZE = 5;
const V2_WORK_ITEM_DRAIN_LIMIT = 30;

type V2CoordinatorCatchUpResult = {
  activeWorkflows: number;
  ticksCaughtUp: number;
};

type V2WorkItemDrainResult = {
  processed: number;
};

function buildCronCorrelationId(value: string): CorrelationId {
  return value as CorrelationId;
}

function asWorkflowId(value: string): WorkflowId {
  return value as WorkflowId;
}

async function runV2CoordinatorCatchUp(): Promise<V2CoordinatorCatchUpResult> {
  const { listActiveWorkflowIds } = await import(
    "@terragon/shared/delivery-loop/store/workflow-store"
  );
  const { runCoordinatorTick } = await import(
    "@/server-lib/delivery-loop/coordinator/tick"
  );
  const activeWorkflows = await listActiveWorkflowIds({
    db,
  });
  let ticksCaughtUp = 0;
  for (const workflow of activeWorkflows) {
    try {
      const tickResult = await runCoordinatorTick({
        db,
        workflowId: asWorkflowId(workflow.id),
        correlationId: buildCronCorrelationId(
          `cron:v2-catch-up:${workflow.id}:${Date.now()}`,
        ),
      });
      if (
        tickResult.transitioned ||
        tickResult.signalsProcessed > 0 ||
        tickResult.workItemsScheduled > 0
      ) {
        ticksCaughtUp += 1;
      }
    } catch (error) {
      console.warn("[cron] v2 coordinator catch-up failed for workflow", {
        workflowId: workflow.id,
        error,
      });
    }
  }
  return { activeWorkflows: activeWorkflows.length, ticksCaughtUp };
}

async function drainDueV2WorkItems(): Promise<V2WorkItemDrainResult> {
  const { claimNextWorkItem, failWorkItem } = await import(
    "@terragon/shared/delivery-loop/store/work-queue-store"
  );
  const {
    runDispatchWork,
    runPublicationWork,
    runBabysitWork,
    runRetryWork,
    runRetrospectiveWork,
  } = await import("@/server-lib/delivery-loop/workers");
  let processed = 0;
  for (let i = 0; i < V2_WORK_ITEM_DRAIN_LIMIT; i += 1) {
    const claimToken = `cron:v2-work:${Date.now()}:${crypto.randomUUID()}`;
    const item = await claimNextWorkItem({
      db,
      claimToken,
    });
    if (!item) {
      break;
    }
    processed += 1;
    try {
      const workflowId = item.workflowId;
      switch (item.kind) {
        case "dispatch":
          await runDispatchWork({
            db,
            workItemId: item.id,
            claimToken,
            payload: item.payloadJson as DispatchWorkPayload,
          });
          break;
        case "publication":
          await runPublicationWork({
            db,
            workItemId: item.id,
            claimToken,
            workflowId,
            payload: item.payloadJson as PublicationWorkPayload,
          });
          break;
        case "babysit":
          await runBabysitWork({
            db,
            workItemId: item.id,
            claimToken,
            payload: item.payloadJson as BabysitWorkPayload,
          });
          break;
        case "retry":
          await runRetryWork({
            db,
            workItemId: item.id,
            claimToken,
            correlationId: item.correlationId,
            payload: item.payloadJson as RetryWorkPayload,
          });
          break;
        case "retrospective":
          await runRetrospectiveWork({
            db,
            workItemId: item.id,
            claimToken,
            payload: item.payloadJson as RetrospectiveWorkPayload,
          });
          break;
        default:
          await failWorkItem({
            db,
            workItemId: item.id,
            claimToken,
            errorCode: "unknown_work_item_kind",
            errorMessage: `Unsupported work item kind "${item.kind}"`,
            terminal: true,
          });
          break;
      }
    } catch (error) {
      console.warn("[cron] v2 work item execution failed", {
        workItemId: item.id,
        kind: item.kind,
        error,
      });
      await failWorkItem({
        db,
        workItemId: item.id,
        claimToken,
        errorCode: "cron_work_item_execution_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { processed };
}

export async function runScheduledTasksCron(): Promise<Response> {
  console.log("Scheduled tasks cron task triggered");
  try {
    const dueThreadChats = await getScheduledThreadChatsDueToRun({ db });
    console.log(`Found ${dueThreadChats.length} thread chats due to run`);

    for (let i = 0; i < dueThreadChats.length; i += BATCH_SIZE) {
      const batch = dueThreadChats.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (threadChat) => {
          await internalPOST(
            `process-scheduled-task/${threadChat.userId}/${threadChat.threadId}/${threadChat.threadChatId}`,
          );
        }),
      );
      const successCount = results.filter(
        (r) => r.status === "fulfilled",
      ).length;
      const failureCount = results.filter(
        (r) => r.status === "rejected",
      ).length;
      console.log(
        `Scheduled tasks cron task batch completed. Success: ${successCount}, Failed: ${failureCount}`,
      );
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("Error in scheduled tasks cron task:", result.reason);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    let v2ActiveWorkflows = 0;
    let v2TicksCaughtUp = 0;
    let v2WorkItemsProcessed = 0;
    let ackTimeoutStalledCount = 0;
    let ackTimeoutProcessedCount = 0;
    let ackTimeoutRetriedCount = 0;
    let v2CatchUpError: string | null = null;
    let v2WorkItemError: string | null = null;
    let ackTimeoutError: string | null = null;
    try {
      const { sweepAckTimeouts } = await import(
        "@/server-lib/delivery-loop/ack-timeout"
      );
      const ackTimeoutResult = await sweepAckTimeouts();
      ackTimeoutStalledCount = ackTimeoutResult.stalledCount;
      ackTimeoutProcessedCount = ackTimeoutResult.processedCount;
      ackTimeoutRetriedCount = ackTimeoutResult.retriedCount;
      if (ackTimeoutResult.stalledCount > 0) {
        console.log(
          "V2 dispatch ack timeout sweep completed",
          ackTimeoutResult,
        );
      }
    } catch (ackErr) {
      console.error("V2 dispatch ack timeout sweep failed", ackErr);
      ackTimeoutError = "v2_ack_timeout_sweep_failed";
    }

    try {
      const catchUpResult = await runV2CoordinatorCatchUp();
      v2ActiveWorkflows = catchUpResult.activeWorkflows;
      v2TicksCaughtUp = catchUpResult.ticksCaughtUp;
      console.log("V2 coordinator tick catch-up completed", {
        activeWorkflows: v2ActiveWorkflows,
        v2TicksCaughtUp,
      });
    } catch (v2TickErr) {
      console.error("V2 coordinator tick catch-up failed", v2TickErr);
      v2CatchUpError = "v2_coordinator_tick_failed";
    }

    try {
      const workItemResult = await drainDueV2WorkItems();
      v2WorkItemsProcessed = workItemResult.processed;
      console.log("V2 delivery loop work items processed", {
        v2WorkItemsProcessed,
      });
    } catch (v2WorkErr) {
      console.error("V2 delivery loop work item drain failed", v2WorkErr);
      v2WorkItemError = "v2_work_item_drain_failed";
    }

    let v3EffectsProcessed = 0;
    let v3OutboxProcessed = 0;
    let v3OutboxPublished = 0;
    let v3OutboxFailed = 0;
    let v3OutboxWorkerProcessed = 0;
    let v3OutboxWorkerAcknowledged = 0;
    let v3OutboxWorkerDeadLettered = 0;
    let v3OutboxWorkerRetried = 0;
    let v3ZombieHeadsScanned = 0;
    let v3ZombieHeadsReconciled = 0;
    let v3EffectsError: string | null = null;
    let v3OutboxError: string | null = null;
    let v3WorkerError: string | null = null;
    let v3ReconcileError: string | null = null;
    // V3 effect-ledger processing (Postgres-canonical runtime kernel).
    try {
      const { drainDueV3Effects } = await import(
        "@/server-lib/delivery-loop/v3/process-effects"
      );
      const v3Result = await drainDueV3Effects({
        db,
        maxItems: 30,
        leaseOwnerPrefix: "cron:v3",
      });
      v3EffectsProcessed = v3Result.processed;
      console.log("V3 delivery effects processed", v3Result);
    } catch (v3Err) {
      console.error("V3 delivery effect processing failed", v3Err);
      v3EffectsError = "v3_effect_processing_failed";
    }

    // V3 outbox relay publishes durable events into Redis for workers.
    try {
      const { drainOutboxV3Relay } = await import(
        "@/server-lib/delivery-loop/v3/relay"
      );
      const v3RelayResult = await drainOutboxV3Relay({
        db,
        maxItems: 30,
        leaseOwnerPrefix: "cron:v3-relay",
      });
      v3OutboxProcessed += v3RelayResult.processed;
      v3OutboxPublished += v3RelayResult.published;
      v3OutboxFailed += v3RelayResult.failed;
      console.log("V3 outbox relay processed", v3RelayResult);
    } catch (relayErr) {
      console.error("V3 outbox relay failed", relayErr);
      v3OutboxError = "v3_outbox_relay_failed";
    }

    try {
      const { drainOutboxV3Worker } = await import(
        "@/server-lib/delivery-loop/v3/worker"
      );
      const v3WorkerResult = await drainOutboxV3Worker({
        db,
        maxItems: 30,
        leaseOwnerPrefix: "cron:v3-worker",
      });
      v3OutboxWorkerProcessed += v3WorkerResult.processed;
      v3OutboxWorkerAcknowledged += v3WorkerResult.acknowledged;
      v3OutboxWorkerDeadLettered += v3WorkerResult.deadLettered;
      v3OutboxWorkerRetried += v3WorkerResult.retried;
      console.log("V3 outbox worker processed", v3WorkerResult);
    } catch (workerErr) {
      console.error("V3 outbox worker failed", workerErr);
      v3WorkerError = "v3_outbox_worker_failed";
    }

    // V3 zombie gate head reconciliation.
    // During migration, legacy delivery_workflow can advance when a webhook
    // arrives, while v3 head stays on a gate state if the mirrored v3 event
    // is missed. Heal stale gate heads from legacy state before the next
    // watchdog or worker pass.
    try {
      const { reconcileZombieGateHeadsFromLegacy } = await import(
        "@/server-lib/delivery-loop/v3/store"
      );
      const reconcileResult = await reconcileZombieGateHeadsFromLegacy({
        db,
        staleMs: 90_000,
        maxRows: 30,
      });
      v3ZombieHeadsScanned = reconcileResult.scanned;
      v3ZombieHeadsReconciled = reconcileResult.reconciled;
      if (reconcileResult.scanned > 0) {
        console.log("V3 zombie gate heads reconciled", reconcileResult);
      }
    } catch (reconcileErr) {
      console.error("V3 zombie gate head reconciliation failed", reconcileErr);
      v3ReconcileError = "v3_zombie_reconcile_failed";
    }

    return Response.json(
      {
        success:
          !ackTimeoutError &&
          !v2CatchUpError &&
          !v2WorkItemError &&
          !v3EffectsError &&
          !v3OutboxError &&
          !v3WorkerError &&
          !v3ReconcileError,
        v2ActiveWorkflows,
        v2TicksCaughtUp,
        v2WorkItemsProcessed,
        ackTimeoutStalledCount,
        ackTimeoutProcessedCount,
        ackTimeoutRetriedCount,
        v3OutboxWorkerProcessed,
        v3OutboxWorkerAcknowledged,
        v3OutboxWorkerDeadLettered,
        v3OutboxWorkerRetried,
        v3EffectsProcessed,
        v3OutboxProcessed,
        v3OutboxPublished,
        v3OutboxFailed,
        v3ZombieHeadsScanned,
        v3ZombieHeadsReconciled,
        ...(ackTimeoutError ? { ackTimeoutError } : {}),
        ...(v2CatchUpError ? { v2CatchUpError } : {}),
        ...(v2WorkItemError ? { v2WorkItemError } : {}),
        ...(v3EffectsError ? { v3EffectsError } : {}),
        ...(v3OutboxError ? { v3OutboxError } : {}),
        ...(v3WorkerError ? { v3WorkerError } : {}),
        ...(v3ReconcileError ? { v3ReconcileError } : {}),
      },
      {
        status:
          ackTimeoutError ||
          v2CatchUpError ||
          v2WorkItemError ||
          v3EffectsError ||
          v3OutboxError ||
          v3WorkerError ||
          v3ReconcileError
            ? 500
            : 200,
      },
    );
  } catch (error) {
    console.error("Scheduled tasks cron failed:", error);
    return Response.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!env.CRON_SECRET || authHeader !== `Bearer ${env.CRON_SECRET}`) {
    // In development without CRON_SECRET, allow access for local testing
    if (process.env.NODE_ENV !== "development" || env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  return runScheduledTasksCron();
}
