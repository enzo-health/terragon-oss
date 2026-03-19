import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drainDueV3Effects } from "@/server-lib/delivery-loop/v3/process-effects";
import { drainOutboxV3Relay } from "@/server-lib/delivery-loop/v3/relay";
import { drainOutboxV3Worker } from "@/server-lib/delivery-loop/v3/worker";
import { reconcileZombieGateHeadsFromLegacy } from "@/server-lib/delivery-loop/v3/store";
import { sweepAckTimeouts } from "@/server-lib/delivery-loop/ack-timeout";
import { listActiveWorkflowIds } from "@terragon/shared/delivery-loop/store/workflow-store";
import { runCoordinatorTick } from "@/server-lib/delivery-loop/coordinator/tick";
import { claimNextWorkItem } from "@terragon/shared/delivery-loop/store/work-queue-store";
import type {
  CorrelationId,
  WorkflowId,
} from "@terragon/shared/delivery-loop/domain/workflow";

let runScheduledTasksCron: typeof import("./route").runScheduledTasksCron;

vi.mock("@/server-lib/delivery-loop/v3/process-effects", () => ({
  drainDueV3Effects: vi.fn(),
}));

vi.mock("@/server-lib/delivery-loop/v3/relay", () => ({
  drainOutboxV3Relay: vi.fn(),
}));

vi.mock("@/server-lib/delivery-loop/v3/worker", () => ({
  drainOutboxV3Worker: vi.fn(),
}));

vi.mock("@/server-lib/delivery-loop/v3/store", () => ({
  reconcileZombieGateHeadsFromLegacy: vi.fn(),
}));

vi.mock("@/server-lib/delivery-loop/ack-timeout", () => ({
  sweepAckTimeouts: vi.fn(),
}));

vi.mock("@terragon/shared/delivery-loop/store/workflow-store", () => ({
  listActiveWorkflowIds: vi.fn(),
}));

vi.mock("@/server-lib/delivery-loop/coordinator/tick", () => ({
  runCoordinatorTick: vi.fn(),
}));

vi.mock("@terragon/shared/delivery-loop/store/work-queue-store", () => ({
  claimNextWorkItem: vi.fn(),
  failWorkItem: vi.fn(),
}));

describe("scheduled-tasks cron route", () => {
  beforeAll(async () => {
    ({ runScheduledTasksCron } = await import("./route"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(drainDueV3Effects).mockResolvedValue({ processed: 2 });
    vi.mocked(drainOutboxV3Relay).mockResolvedValue({
      processed: 1,
      published: 1,
      failed: 0,
    });
    vi.mocked(drainOutboxV3Worker).mockResolvedValue({
      processed: 1,
      acknowledged: 1,
      deadLettered: 0,
      retried: 0,
    });
    vi.mocked(reconcileZombieGateHeadsFromLegacy).mockResolvedValue({
      scanned: 1,
      reconciled: 1,
    });
    vi.mocked(sweepAckTimeouts).mockResolvedValue({
      stalledCount: 0,
      processedCount: 0,
      retriedCount: 0,
    });
    vi.mocked(listActiveWorkflowIds).mockResolvedValue([]);
    vi.mocked(runCoordinatorTick).mockResolvedValue({
      workflowId: "wf-1" as WorkflowId,
      correlationId: "corr-1" as CorrelationId,
      signalsProcessed: 0,
      transitioned: false,
      stateBefore: "planning",
      stateAfter: "planning",
      workItemsScheduled: 0,
      incidentsEvaluated: false,
    });
    vi.mocked(claimNextWorkItem).mockResolvedValue(null);
  });

  it("runs v2 + v3 maintenance passes and reports progression counters", async () => {
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
      v2ActiveWorkflows: 0,
      v2TicksCaughtUp: 0,
      v2WorkItemsProcessed: 0,
      ackTimeoutStalledCount: 0,
      ackTimeoutProcessedCount: 0,
      ackTimeoutRetriedCount: 0,
    });
    expect(drainDueV3Effects).toHaveBeenCalledWith(
      expect.objectContaining({ leaseOwnerPrefix: "cron:v3" }),
    );
    expect(drainOutboxV3Relay).toHaveBeenCalledWith(
      expect.objectContaining({ leaseOwnerPrefix: "cron:v3-relay" }),
    );
    expect(drainOutboxV3Worker).toHaveBeenCalledWith(
      expect.objectContaining({ leaseOwnerPrefix: "cron:v3-worker" }),
    );
    expect(reconcileZombieGateHeadsFromLegacy).toHaveBeenCalledWith(
      expect.objectContaining({ staleMs: 90_000, maxRows: 30 }),
    );
    expect(sweepAckTimeouts).toHaveBeenCalled();
    expect(listActiveWorkflowIds).toHaveBeenCalledWith(
      expect.objectContaining({ db: expect.anything() }),
    );
    expect(claimNextWorkItem).toHaveBeenCalled();
  });

  it("surfaces v3 effect processing failures in watchdog response", async () => {
    vi.mocked(drainDueV3Effects).mockRejectedValueOnce(
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
      v2ActiveWorkflows: 0,
      v2TicksCaughtUp: 0,
      v2WorkItemsProcessed: 0,
      ackTimeoutStalledCount: 0,
      ackTimeoutProcessedCount: 0,
      ackTimeoutRetriedCount: 0,
    });
    expect(drainOutboxV3Relay).toHaveBeenCalled();
    expect(drainOutboxV3Worker).toHaveBeenCalled();
  });
});
