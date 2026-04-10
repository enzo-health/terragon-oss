import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { env } from "@leo/env/apps-www";
import { getScheduledAutomationsDueToRun } from "@leo/shared/model/automations";
import { runAutomation } from "@/server-lib/automations";

const BATCH_SIZE = 5;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  console.log("Automations cron task triggered");
  try {
    const dueAutomations = await getScheduledAutomationsDueToRun({ db });
    console.log(`Found ${dueAutomations.length} automations due to run`);

    for (let i = 0; i < dueAutomations.length; i += BATCH_SIZE) {
      const batch = dueAutomations.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (automation) => {
          await runAutomation({
            automationId: automation.id,
            userId: automation.userId,
            source: "automated",
          });
        }),
      );
      const successCount = results.filter(
        (r) => r.status === "fulfilled",
      ).length;
      const failureCount = results.filter(
        (r) => r.status === "rejected",
      ).length;
      console.log(
        `Automations cron task batch completed. Success: ${successCount}, Failed: ${failureCount}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return Response.json({
      success: true,
    });
  } catch (error) {
    console.error("Error in automations cron task:", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
