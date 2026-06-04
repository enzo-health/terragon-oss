import type { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";
import { db } from "@/lib/db";
import {
  RUN_DEADLINE_CUTOFF_SECS,
  runDeadlineSweep,
} from "@/server-lib/run-deadline-sweep";

// Fast safety net (runs every ~2 min, see vercel.json). Drives run-contexts
// stuck in a live status past RUN_DEADLINE_CUTOFF_SECS to a terminal status so
// the composer un-sticks. The hourly stalled-tasks cron remains the coarse net.
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
  console.log("Run deadline sweep cron task triggered");
  const result = await runDeadlineSweep({
    db,
    cutoffSecs: RUN_DEADLINE_CUTOFF_SECS,
  });
  console.log(
    `Run deadline sweep completed. Scanned: ${result.scanned}, Terminated: ${result.terminated}, Skipped: ${result.skipped}`,
  );
  return Response.json({ success: true, ...result });
}
