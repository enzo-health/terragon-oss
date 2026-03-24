import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drainDueEffects } from "@/server-lib/delivery-loop/v3/process-effects";
import { drainOutboxRelay } from "@/server-lib/delivery-loop/v3/relay";
import { drainOutboxWorker } from "@/server-lib/delivery-loop/v3/worker";
import { reconcileZombieGateHeadsFromLegacy } from "@/server-lib/delivery-loop/v3/store";

let runScheduledTasksCron: typeof import("./route").runScheduledTasksCron;

vi.mock("@/server-lib/delivery-loop/v3/process-effects", () => ({
  drainDueEffects: vi.fn(),
}));

vi.mock("@/server-lib/delivery-loop/v3/relay", () => ({
  drainOutboxRelay: vi.fn(),
}));

vi.mock("@/server-lib/delivery-loop/v3/worker", () => ({
  drainOutboxWorker: vi.fn(),
}));

vi.mock("@/server-lib/delivery-loop/v3/store", () => ({
  reconcileZombieGateHeadsFromLegacy: vi.fn(),
}));

describe("scheduled-tasks cron route", () => {
  beforeAll(async () => {
    ({ runScheduledTasksCron } = await import("./route"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(drainDueEffects).mockResolvedValue({ processed: 2 });
    vi.mocked(drainOutboxRelay).mockResolvedValue({
      processed: 1,
      published: 1,
      failed: 0,
    });
    vi.mocked(drainOutboxWorker).mockResolvedValue({
      processed: 1,
      acknowledged: 1,
      deadLettered: 0,
      retried: 0,
    });
    vi.mocked(reconcileZombieGateHeadsFromLegacy).mockResolvedValue({
      scanned: 1,
      reconciled: 1,
    });
  });

  it("runs v3 maintenance passes and reports progression counters", async () => {
    const response = await runScheduledTasksCron();
    const data = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      success: true,
      v3EffectsProcessed: 2,
      v3OutboxProcessed: 1,
      v3OutboxPublished: 1,
      v3OutboxFailed: 0,
      v3OutboxWorkerProcessed: 1,
      v3OutboxWorkerAcknowledged: 1,
      v3OutboxWorkerDeadLettered: 0,
      v3OutboxWorkerRetried: 0,
      v3ZombieHeadsScanned: 1,
      v3ZombieHeadsReconciled: 1,
    });
    expect(drainDueEffects).toHaveBeenCalledWith(
      expect.objectContaining({ leaseOwnerPrefix: "cron:v3" }),
    );
    expect(drainOutboxRelay).toHaveBeenCalledWith(
      expect.objectContaining({ leaseOwnerPrefix: "cron:v3-relay" }),
    );
    expect(drainOutboxWorker).toHaveBeenCalledWith(
      expect.objectContaining({ leaseOwnerPrefix: "cron:v3-worker" }),
    );
    expect(reconcileZombieGateHeadsFromLegacy).toHaveBeenCalledWith(
      expect.objectContaining({ staleMs: 90_000, maxRows: 30 }),
    );
  });

  it("surfaces v3 effect processing failures in watchdog response", async () => {
    vi.mocked(drainDueEffects).mockRejectedValueOnce(
      new Error("effect drain failed"),
    );

    const response = await runScheduledTasksCron();
    const data = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(data).toMatchObject({
      success: false,
      v3EffectsProcessed: 0,
      v3EffectsError: "v3_effect_processing_failed",
      v3OutboxProcessed: 1,
      v3OutboxPublished: 1,
      v3OutboxWorkerProcessed: 1,
    });
    expect(drainOutboxRelay).toHaveBeenCalled();
    expect(drainOutboxWorker).toHaveBeenCalled();
  });
});
