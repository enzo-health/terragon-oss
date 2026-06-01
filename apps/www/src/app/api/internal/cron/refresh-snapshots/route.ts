import type { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";
import {
  reapOrphanEnvironmentSnapshots,
  refreshStaleEnvironmentSnapshots,
} from "@/server-lib/environment-snapshot-lifecycle";
import { db } from "@/lib/db";

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
    refreshed = await refreshStaleEnvironmentSnapshots({ db });
  } catch (error) {
    console.error("[refresh-snapshots] refresh pass failed:", error);
  }
  try {
    reaped = await reapOrphanEnvironmentSnapshots({ db });
  } catch (error) {
    console.error("[refresh-snapshots] reap pass failed:", error);
  }
  console.log(
    `[refresh-snapshots] cron done — refreshed ${refreshed}, reaped ${reaped}`,
  );
  return Response.json({ success: true, refreshed, reaped });
}
