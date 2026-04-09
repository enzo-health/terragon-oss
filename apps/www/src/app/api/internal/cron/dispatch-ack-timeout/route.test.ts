import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { drainDueEffects } from "@/server-lib/delivery-loop/v3/process-effects";

let GET: typeof import("./route").GET;
let runDispatchAckTimeoutCron: typeof import("./route").runDispatchAckTimeoutCron;

vi.mock("@/server-lib/delivery-loop/v3/process-effects", () => ({
  drainDueEffects: vi.fn(),
}));

describe("dispatch-ack-timeout cron route", () => {
  beforeAll(async () => {
    ({ GET, runDispatchAckTimeoutCron } = await import("./route"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(drainDueEffects).mockResolvedValue({ processed: 3 });
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

      // Drain should not be called when auth fails
      expect(drainDueEffects).not.toHaveBeenCalled();

      vi.unstubAllEnvs();
    });

    it("rejects requests with invalid auth header in production", async () => {
      vi.stubEnv("NODE_ENV", "production" as NodeJS.ProcessEnv["NODE_ENV"]);

      const request = {
        headers: new Headers({
          authorization: "Bearer wrong-secret",
        }),
      } as NextRequest;

      const response = await GET(request);

      expect(response.status).toBe(401);
      expect(drainDueEffects).not.toHaveBeenCalled();

      vi.unstubAllEnvs();
    });
  });

  describe("due effect drain (VAL-API-010)", () => {
    it("drains due effects with dispatch-ack-timeout lease owner prefix", async () => {
      vi.mocked(drainDueEffects).mockResolvedValue({ processed: 5 });

      const response = await runDispatchAckTimeoutCron();
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(drainDueEffects).toHaveBeenCalledWith(
        expect.objectContaining({
          leaseOwnerPrefix: "cron:dispatch-ack-timeout",
          maxItems: 30,
        }),
      );
      expect(data).toMatchObject({
        success: true,
        v3: { processed: 5 },
      });
    });

    it("returns success response with processed count", async () => {
      vi.mocked(drainDueEffects).mockResolvedValue({ processed: 10 });

      const response = await runDispatchAckTimeoutCron();
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data).toEqual({
        success: true,
        v3: { processed: 10 },
      });
    });
  });
});
