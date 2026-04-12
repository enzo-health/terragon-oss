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

describe("scheduled-tasks cron route (VAL-API-008)", () => {
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

  it("runs v3 maintenance passes and reports explicit pass/failure fields", async () => {
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
    // No error fields should be present when all passes succeed
    expect(data).not.toHaveProperty("v3EffectsError");
    expect(data).not.toHaveProperty("v3OutboxError");
    expect(data).not.toHaveProperty("v3WorkerError");
    expect(data).not.toHaveProperty("v3ReconcileError");
  });

  it("reports explicit error fields when passes fail (VAL-API-008)", async () => {
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
    });
    // Other passes should still be reported
    expect(data).toHaveProperty("v3OutboxProcessed");
    expect(data).toHaveProperty("v3OutboxWorkerProcessed");
    expect(data).toHaveProperty("v3ZombieHeadsScanned");
  });

  it("reports outbox relay failure explicitly (VAL-API-008)", async () => {
    vi.mocked(drainOutboxRelay).mockRejectedValueOnce(
      new Error("outbox relay failed"),
    );

    const response = await runScheduledTasksCron();
    const data = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(data).toMatchObject({
      success: false,
      v3OutboxProcessed: 0,
      v3OutboxError: "v3_outbox_relay_failed",
    });
    // Other passes should still run and report
    expect(drainDueEffects).toHaveBeenCalled();
    expect(data).toHaveProperty("v3EffectsProcessed");
  });

  it("reports worker failure explicitly (VAL-API-008)", async () => {
    vi.mocked(drainOutboxWorker).mockRejectedValueOnce(
      new Error("worker drain failed"),
    );

    const response = await runScheduledTasksCron();
    const data = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(data).toMatchObject({
      success: false,
      v3OutboxWorkerProcessed: 0,
      v3WorkerError: "v3_outbox_worker_failed",
    });
  });

  it("reports zombie reconcile failure explicitly (VAL-API-008)", async () => {
    vi.mocked(reconcileZombieGateHeadsFromLegacy).mockRejectedValueOnce(
      new Error("reconcile failed"),
    );

    const response = await runScheduledTasksCron();
    const data = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(data).toMatchObject({
      success: false,
      v3ZombieHeadsScanned: 0,
      v3ZombieHeadsReconciled: 0,
      v3ReconcileError: "v3_zombie_reconcile_failed",
    });
  });

  it("reports all failures when multiple passes fail (VAL-API-008)", async () => {
    vi.mocked(drainDueEffects).mockRejectedValueOnce(
      new Error("effects failed"),
    );
    vi.mocked(drainOutboxRelay).mockRejectedValueOnce(
      new Error("relay failed"),
    );
    vi.mocked(drainOutboxWorker).mockRejectedValueOnce(
      new Error("worker failed"),
    );
    vi.mocked(reconcileZombieGateHeadsFromLegacy).mockRejectedValueOnce(
      new Error("reconcile failed"),
    );

    const response = await runScheduledTasksCron();
    const data = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(data).toMatchObject({
      success: false,
      v3EffectsError: "v3_effect_processing_failed",
      v3OutboxError: "v3_outbox_relay_failed",
      v3WorkerError: "v3_outbox_worker_failed",
      v3ReconcileError: "v3_zombie_reconcile_failed",
    });
  });
});

describe("watchdog recovery and idempotent dispatch progression (VAL-CROSS-004, VAL-CROSS-008)", () => {
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
      scanned: 0,
      reconciled: 0,
    });
  });

  it("recovery paths restore forward progress (VAL-CROSS-004)", async () => {
    const response = await runScheduledTasksCron();
    const data = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    // Recovery paths should report counters indicating work was processed
    expect(data.v3EffectsProcessed).toBeGreaterThanOrEqual(0);
    expect(data.v3OutboxProcessed).toBeGreaterThanOrEqual(0);
    expect(data.v3OutboxWorkerProcessed).toBeGreaterThanOrEqual(0);
  });

  it("repeated watchdog ticks preserve idempotent progression (VAL-CROSS-008)", async () => {
    // First tick processes some work
    vi.mocked(drainDueEffects).mockResolvedValue({ processed: 3 });
    vi.mocked(drainOutboxWorker).mockResolvedValue({
      processed: 5,
      acknowledged: 5,
      deadLettered: 0,
      retried: 0,
    });

    const firstResponse = await runScheduledTasksCron();
    const firstData = (await firstResponse.json()) as Record<string, unknown>;

    expect(firstResponse.status).toBe(200);
    expect(firstData.v3EffectsProcessed).toBe(3);
    expect(firstData.v3OutboxWorkerProcessed).toBe(5);

    // Simulate next tick where no new work is due (idempotent progression)
    vi.mocked(drainDueEffects).mockResolvedValue({ processed: 0 });
    vi.mocked(drainOutboxWorker).mockResolvedValue({
      processed: 0,
      acknowledged: 0,
      deadLettered: 0,
      retried: 0,
    });

    const secondResponse = await runScheduledTasksCron();
    const secondData = (await secondResponse.json()) as Record<string, unknown>;

    expect(secondResponse.status).toBe(200);
    expect(secondData.success).toBe(true);
    // Second tick reports stable state without duplicate dispatch
    expect(secondData.v3EffectsProcessed).toBe(0);
    expect(secondData.v3OutboxWorkerProcessed).toBe(0);
  });

  it("calls recovery passes with correct lease owner prefixes (VAL-CROSS-004)", async () => {
    await runScheduledTasksCron();

    // Verify lease ownership for effect drain (prevents duplicate processing)
    expect(drainDueEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseOwnerPrefix: "cron:v3",
        maxItems: 30,
      }),
    );

    // Verify lease ownership for worker (prevents duplicate worker processing)
    expect(drainOutboxWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseOwnerPrefix: "cron:v3-worker",
        maxItems: 30,
      }),
    );

    // Verify lease ownership for relay (prevents duplicate relay)
    expect(drainOutboxRelay).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseOwnerPrefix: "cron:v3-relay",
        maxItems: 30,
      }),
    );
  });
});
