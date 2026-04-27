import { env } from "@terragon/env/apps-www";
import type { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

let GET: typeof import("./route").GET;
let runDispatchAckTimeoutCron: typeof import("./route").runDispatchAckTimeoutCron;

describe("dispatch-ack-timeout cron route", () => {
  beforeAll(async () => {
    ({ GET, runDispatchAckTimeoutCron } = await import("./route"));
  });

  describe("production auth enforcement (VAL-API-009)", () => {
    it("rejects requests without auth header in production", async () => {
      vi.stubEnv("NODE_ENV", "production" as NodeJS.ProcessEnv["NODE_ENV"]);

      const request = {
        headers: new Headers({}),
      } as NextRequest;

      const response = await GET(request);

      expect(response.status).toBe(401);
      const text = await response.text();
      expect(text).toBe("Unauthorized");

      vi.unstubAllEnvs();
    });

    it("rejects requests with invalid auth header in production", async () => {
      vi.stubEnv("NODE_ENV", "production" as NodeJS.ProcessEnv["NODE_ENV"]);

      const request = {
        headers: new Headers({
          authorization: `Bearer ${env.CRON_SECRET}-wrong`,
        }),
      } as NextRequest;

      const response = await GET(request);

      expect(response.status).toBe(401);

      vi.unstubAllEnvs();
    });
  });

  describe("quiesced delivery-loop drain", () => {
    it("reports a successful no-op instead of draining delivery-loop effects", async () => {
      const response = await runDispatchAckTimeoutCron();
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data).toEqual({
        success: true,
        v3: {
          processed: 0,
          quiesced: true,
        },
      });
    });
  });
});
