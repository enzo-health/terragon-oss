import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { getScheduledThreadChatsDueToRun } from "@terragon/shared/model/threads";
import { internalPOST } from "@/server-lib/internal-request";

const BATCH_SIZE = 5;

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
      const { drainDueEffects } = await import(
        "@/server-lib/delivery-loop/v3/process-effects"
      );
      const v3Result = await drainDueEffects({
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
      const { drainOutboxRelay } = await import(
        "@/server-lib/delivery-loop/v3/relay"
      );
      const v3RelayResult = await drainOutboxRelay({
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
      const { drainOutboxWorker } = await import(
        "@/server-lib/delivery-loop/v3/worker"
      );
      const v3WorkerResult = await drainOutboxWorker({
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
          !v3EffectsError &&
          !v3OutboxError &&
          !v3WorkerError &&
          !v3ReconcileError,
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
        ...(v3EffectsError ? { v3EffectsError } : {}),
        ...(v3OutboxError ? { v3OutboxError } : {}),
        ...(v3WorkerError ? { v3WorkerError } : {}),
        ...(v3ReconcileError ? { v3ReconcileError } : {}),
      },
      {
        status:
          v3EffectsError || v3OutboxError || v3WorkerError || v3ReconcileError
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
