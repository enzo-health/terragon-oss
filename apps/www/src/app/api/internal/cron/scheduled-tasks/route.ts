import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { getScheduledThreadChatsDueToRun } from "@terragon/shared/model/threads";
import { internalPOST } from "@/server-lib/internal-request";

const BATCH_SIZE = 5;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!env.CRON_SECRET || authHeader !== `Bearer ${env.CRON_SECRET}`) {
    // In development without CRON_SECRET, allow access for local testing
    if (process.env.NODE_ENV !== "development" || env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }
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

    // V2 delivery loop work item processing
    let v2WorkItemsProcessed = 0;
    let v2TicksCaughtUp = 0;
    let v2Error: string | null = null;
    try {
      const { claimNextWorkItem } = await import(
        "@terragon/shared/delivery-loop/store/work-queue-store"
      );
      const { runDispatchWork } = await import(
        "@/server-lib/delivery-loop/workers/run-dispatch-work"
      );
      const { runPublicationWork } = await import(
        "@/server-lib/delivery-loop/workers/run-publication-work"
      );
      const { runBabysitWork } = await import(
        "@/server-lib/delivery-loop/workers/run-babysit-work"
      );
      const { runRetryWork } = await import(
        "@/server-lib/delivery-loop/workers/run-retry-work"
      );

      const MAX_V2_WORK_ITEMS = 20;

      for (let i = 0; i < MAX_V2_WORK_ITEMS; i++) {
        const claimToken = `cron:v2:${crypto.randomUUID()}`;
        const item = await claimNextWorkItem({ db, claimToken });
        if (!item) break;

        const payload = item.payloadJson as Record<string, unknown>;

        switch (item.kind) {
          case "dispatch":
            await runDispatchWork({
              db,
              workItemId: item.id,
              claimToken,
              payload: payload as Parameters<
                typeof runDispatchWork
              >[0]["payload"],
            });
            break;
          case "publication":
            await runPublicationWork({
              db,
              workItemId: item.id,
              claimToken,
              workflowId: item.workflowId,
              payload: payload as Parameters<
                typeof runPublicationWork
              >[0]["payload"],
            });
            break;
          case "babysit":
            await runBabysitWork({
              db,
              workItemId: item.id,
              claimToken,
              payload: payload as Parameters<
                typeof runBabysitWork
              >[0]["payload"],
            });
            break;
          case "retry":
            await runRetryWork({
              db,
              workItemId: item.id,
              claimToken,
              correlationId: item.correlationId,
              payload: payload as Parameters<typeof runRetryWork>[0]["payload"],
            });
            break;
        }
        v2WorkItemsProcessed++;
      }
      console.log("V2 delivery loop work items processed", {
        v2WorkItemsProcessed,
      });

      // Drain legacy follow-up retry jobs (still produced by process-follow-up-queue)
      try {
        const { drainDueDeliveryLoopRetryJobs } = await import(
          "@/server-lib/delivery-loop/retry-jobs"
        );
        const retryResult = await drainDueDeliveryLoopRetryJobs({
          leaseOwnerTokenPrefix: "cron:retry",
        });
        console.log("V2 follow-up retry jobs drained", retryResult);
      } catch (retryErr) {
        console.error("V2 follow-up retry job drain failed", retryErr);
      }

      // Coordinator tick catch-up for active workflows with pending signals
      const { listActiveWorkflowIds } = await import(
        "@terragon/shared/delivery-loop/store/workflow-store"
      );
      const { runCoordinatorTick } = await import(
        "@/server-lib/delivery-loop/coordinator/tick"
      );
      const { and, desc, inArray } = await import("drizzle-orm");
      const schemaImport = await import("@terragon/shared/db/schema");
      const { activeSdlcLoopStateList } = await import(
        "@terragon/shared/model/delivery-loop"
      );

      const activeWorkflows = await listActiveWorkflowIds({ db, limit: 50 });

      // Batch-load sdlcLoop IDs for all active workflows to avoid N+1 queries.
      const threadIds = activeWorkflows.map((wf) => wf.threadId);
      const loops =
        threadIds.length > 0
          ? await db.query.sdlcLoop.findMany({
              where: and(
                inArray(schemaImport.sdlcLoop.threadId, threadIds),
                inArray(schemaImport.sdlcLoop.state, activeSdlcLoopStateList),
              ),
              orderBy: [desc(schemaImport.sdlcLoop.createdAt)],
              columns: { id: true, threadId: true },
            })
          : [];
      // Map threadId → most recent active loop (first match, since ordered desc)
      const loopByThread = new Map<string, string>();
      for (const loop of loops) {
        if (!loopByThread.has(loop.threadId)) {
          loopByThread.set(loop.threadId, loop.id);
        }
      }

      for (const wf of activeWorkflows) {
        try {
          const correlationId =
            `cron:tick-catchup:${wf.id}:${Date.now()}` as Parameters<
              typeof runCoordinatorTick
            >[0]["correlationId"];
          const result = await runCoordinatorTick({
            db,
            workflowId: wf.id as Parameters<
              typeof runCoordinatorTick
            >[0]["workflowId"],
            correlationId,
            claimToken: `cron:tick:${crypto.randomUUID()}`,
            loopId: loopByThread.get(wf.threadId),
          });
          if (result.signalsProcessed > 0) {
            v2TicksCaughtUp++;
          }
        } catch (tickErr) {
          console.error(
            `V2 coordinator tick catch-up failed for workflow ${wf.id}`,
            tickErr,
          );
        }
      }
      console.log("V2 coordinator tick catch-up completed", {
        activeWorkflows: activeWorkflows.length,
        v2TicksCaughtUp,
      });
    } catch (error) {
      console.error("V2 delivery loop cron processing failed", error);
      v2Error = "v2_processing_failed";
    }

    return Response.json(
      {
        success: !v2Error,
        v2WorkItemsProcessed,
        v2TicksCaughtUp,
        ...(v2Error ? { v2Error } : {}),
      },
      { status: v2Error ? 207 : 200 },
    );
  } catch (error) {
    console.error("Scheduled tasks cron failed:", error);
    return Response.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
