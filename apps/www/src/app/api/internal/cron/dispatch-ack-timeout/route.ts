import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { drainDueEffects } from "@/server-lib/delivery-loop/v3/process-effects";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await drainDueEffects({
    db,
    maxItems: 30,
    leaseOwnerPrefix: "cron:dispatch-ack-timeout",
  });
  console.log("[cron] dispatch-ack-timeout sweep completed", { v3: result });
  return Response.json({ success: true, v3: result });
}
