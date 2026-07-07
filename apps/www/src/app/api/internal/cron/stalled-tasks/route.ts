import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import {
  getStaleBootingThreadChats,
  requeueStaleBootingThreadChats,
} from "@/server-lib/booting-recovery";
import { runDeadlineSweep } from "@/server-lib/run-deadline-sweep";

const STALE_BOOTING_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const STALLED_THREAD_CHAT_CUTOFF_SECS = 60 * 60; // 1 hour

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
  const sweepResult = await runDeadlineSweep({
    db,
    cutoffSecs: STALLED_THREAD_CHAT_CUTOFF_SECS,
  });
  console.log(
    `Stalled tasks run deadline sweep completed. Scanned: ${sweepResult.scanned}, Terminated: ${sweepResult.terminated}, Skipped: ${sweepResult.skipped}`,
  );
  console.log("Stalled tasks cron task completed");
  return Response.json({ success: true });
}
