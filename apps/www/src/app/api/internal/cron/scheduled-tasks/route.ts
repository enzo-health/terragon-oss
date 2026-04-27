import { env } from "@terragon/env/apps-www";
import { getScheduledThreadChatsDueToRun } from "@terragon/shared/model/threads";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
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

    return Response.json(
      {
        success: true,
        deliveryLoopDrainers: "quiesced",
        v3OutboxWorkerProcessed: 0,
        v3OutboxWorkerAcknowledged: 0,
        v3OutboxWorkerDeadLettered: 0,
        v3OutboxWorkerRetried: 0,
        v3EffectsProcessed: 0,
        v3OutboxProcessed: 0,
        v3OutboxPublished: 0,
        v3OutboxFailed: 0,
        v3ZombieHeadsScanned: 0,
        v3ZombieHeadsReconciled: 0,
      },
      { status: 200 },
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
