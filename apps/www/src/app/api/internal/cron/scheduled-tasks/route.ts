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

    const { drainDueSdlcSignalInboxActions } = await import(
      "@/server-lib/sdlc-loop/signal-inbox"
    );
    const sdlcSignalInboxDrain = await drainDueSdlcSignalInboxActions({
      db,
      leaseOwnerTokenPrefix: "internal-cron:scheduled-tasks",
    });
    console.log(
      "SDLC signal inbox durable drain completed",
      sdlcSignalInboxDrain,
    );

    const { drainDueSdlcPublicationOutboxActions } = await import(
      "@/server-lib/sdlc-loop/publication"
    );
    const sdlcPublicationDrain = await drainDueSdlcPublicationOutboxActions({
      db,
      leaseOwnerTokenPrefix: "internal-cron:scheduled-tasks",
    });
    console.log(
      "SDLC publication durable drain completed",
      sdlcPublicationDrain,
    );

    return Response.json({
      success: true,
      sdlcSignalInboxDrain,
      sdlcPublicationDrain,
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
