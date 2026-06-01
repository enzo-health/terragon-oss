import type { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";
import { db } from "@/lib/db";
import { runEnvironmentSnapshotMaintenance } from "@/server-lib/environment-snapshot-scheduler";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  console.log("[refresh-snapshots] cron started");
  let refreshed = 0;
  let reaped = 0;
  try {
    const result = await runEnvironmentSnapshotMaintenance({ db });
    refreshed = result.refreshed;
    reaped = result.reaped;
  } catch (error) {
    console.error("[refresh-snapshots] maintenance pass failed:", error);
  }
  console.log(
    `[refresh-snapshots] cron done — refreshed ${refreshed}, reaped ${reaped}`,
  );
  return Response.json({ success: true, refreshed, reaped });
}
