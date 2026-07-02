import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import {
  getStaleBootingThreadChats,
  requeueStaleBootingThreadChats,
} from "@/server-lib/booting-recovery";

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
  console.log("Stalled tasks cron task completed");
  return Response.json({ success: true });
}
