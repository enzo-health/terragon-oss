import type { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";
import { sweepAckTimeouts } from "@/server-lib/delivery-loop/ack-timeout";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await sweepAckTimeouts();
  console.log("[cron] dispatch-ack-timeout sweep completed", result);
  return Response.json({ success: true, ...result });
}
