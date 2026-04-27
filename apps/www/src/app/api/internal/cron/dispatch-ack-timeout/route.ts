import { env } from "@terragon/env/apps-www";
import type { NextRequest } from "next/server";

export async function runDispatchAckTimeoutCron(): Promise<Response> {
  console.log("[cron] dispatch-ack-timeout sweep quiesced");
  return Response.json({
    success: true,
    v3: {
      processed: 0,
      quiesced: true,
    },
  });
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  return runDispatchAckTimeoutCron();
}
