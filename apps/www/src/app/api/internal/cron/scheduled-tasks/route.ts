import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { getScheduledThreadChatsDueToRun } from "@terragon/shared/model/threads";
import { internalPOST } from "@/server-lib/internal-request";

const BATCH_SIZE = 5;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
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
        const claimToken = `cron:scheduled-tasks:v2:${Date.now()}:${i}`;
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

      // Coordinator tick catch-up for active workflows with pending signals
      const { listActiveWorkflowIds } = await import(
        "@terragon/shared/delivery-loop/store/workflow-store"
      );
      const { runCoordinatorTick } = await import(
        "@/server-lib/delivery-loop/coordinator/tick"
      );

      const activeWorkflows = await listActiveWorkflowIds({ db, limit: 50 });
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
            claimToken: `cron:scheduled-tasks:v2:tick:${Date.now()}`,
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
    }

    return Response.json({
      success: true,
      v2WorkItemsProcessed,
      v2TicksCaughtUp,
    });
  } catch (error) {
    console.error("Error in scheduled tasks cron task:", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
