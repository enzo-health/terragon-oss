import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import {
  getMacMiniWorkers,
  recordHealthCheck,
} from "@terragon/shared/model/mac-mini-workers";
import { decryptValue } from "@terragon/utils/encryption";

// This is run every minute, see vercel.json.
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  console.log("Mac Mini health check cron triggered");

  const workers = await getMacMiniWorkers(db);
  console.log(`Checking health of ${workers.length} Mac Mini workers`);

  const results = await Promise.allSettled(
    workers.map(async (worker) => {
      const apiKey = decryptValue(
        worker.apiKeyEncrypted,
        env.ENCRYPTION_MASTER_KEY,
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      let success = false;
      let info:
        | { openSandboxVersion?: string; dockerVersion?: string }
        | undefined;

      try {
        const response = await fetch(
          `http://${worker.hostname}:${worker.port}/health`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
          },
        );
        success = response.ok;
        if (success) {
          try {
            const json = await response.json();
            info = {
              openSandboxVersion: json.version ?? undefined,
              dockerVersion: json.docker_version ?? undefined,
            };
          } catch {
            // Response body not JSON — ignore
          }
        }
      } catch (error) {
        success = false;
        console.warn(
          `Health check failed for worker ${worker.name} (${worker.hostname}:${worker.port}):`,
          error,
        );
      } finally {
        clearTimeout(timer);
      }

      await recordHealthCheck(db, worker.id, success, info);
      return { workerId: worker.id, success };
    }),
  );

  const online = results.filter(
    (r) => r.status === "fulfilled" && r.value.success,
  ).length;
  const offline = results.filter(
    (r) =>
      r.status === "rejected" || (r.status === "fulfilled" && !r.value.success),
  ).length;

  console.log(
    `Mac Mini health check complete. Online: ${online}, Offline: ${offline}`,
  );

  return Response.json({ checked: workers.length, online, offline });
}
