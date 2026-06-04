import type { NextRequest } from "next/server";
import {
  getStalledThreads,
  stopStalledThreads,
} from "@terragon/shared/model/threads";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { maybeHibernateSandboxById } from "@/agent/sandbox";
import {
  getStaleBootingThreadChats,
  requeueStaleBootingThreadChats,
} from "@/server-lib/booting-recovery";

async function sleep(ms: number = 1000) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopStalledThreadsTask() {
  console.log("Processing stalled threads");
  const stalledThreads = await getStalledThreads({ db });
  console.log(`Found ${stalledThreads.length} stalled threads`);
  if (stalledThreads.length === 0) {
    return;
  }

  console.log("Stopping stalled threads");
  console.log(stalledThreads.map((thread) => thread.id).join(", "));
  await stopStalledThreads({
    db,
    threadIds: stalledThreads.map((thread) => thread.id),
  });

  // Hibernate the sandboxes in batches of 10
  console.log("Hibernating sandboxes");
  for (let i = 0; i < stalledThreads.length; i += 10) {
    const batch = stalledThreads.slice(i, i + 10);
    await Promise.all(
      batch.map(async (thread) => {
        if (thread.codesandboxId) {
          try {
            await maybeHibernateSandboxById({
              threadId: thread.id,
              userId: thread.userId,
              sandboxId: thread.codesandboxId,
              sandboxProvider: thread.sandboxProvider,
            });
          } catch (error) {
            // Ignore errors
          }
        }
      }),
    );
    await sleep();
  }
}

const STALE_BOOTING_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

async function requeueStaleBootingThreadChatsTask() {
  console.log("Processing stale booting thread chats");
  const staleBootingThreadChats = await getStaleBootingThreadChats({
    db,
    maxAgeMs: STALE_BOOTING_MAX_AGE_MS,
  });
  console.log(
    `Found ${staleBootingThreadChats.length} stale booting thread chats`,
  );
  if (staleBootingThreadChats.length === 0) {
    return;
  }
  const { requeuedCount } = await requeueStaleBootingThreadChats({
    db,
    threadChats: staleBootingThreadChats,
  });
  console.log(`Requeued ${requeuedCount} stale booting thread chats`);
}

// This is run hourly, see vercel.json.
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", {
      status: 401,
    });
  }
  console.log("Stalled tasks cron task triggered");
  await requeueStaleBootingThreadChatsTask();
  await stopStalledThreadsTask();
  console.log("Stalled tasks cron task completed");
  return Response.json({ success: true });
}
