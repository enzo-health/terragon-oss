import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DaemonEventPayload } from "./daemon-ingress";
import { normalizeDaemonEvent, handleDaemonIngress } from "./daemon-ingress";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";
import type { DeliverySignal } from "@terragon/shared/delivery-loop/domain/signals";

// ── mocks ──────────────────────────────────────────────────────────────
vi.mock("@terragon/shared/delivery-loop/store/signal-inbox-store", () => ({
  appendSignalToInbox: vi.fn().mockResolvedValue([{ id: "sig-1" }]),
}));

vi.mock("../../coordinator/tick", () => ({
  runCoordinatorTick: vi.fn().mockResolvedValue({
    workflowId: "wf-1",
    correlationId: "corr-1",
    signalsProcessed: 1,
    transitioned: false,
    stateBefore: "implementing",
    stateAfter: "implementing",
    workItemsScheduled: 0,
    incidentsEvaluated: false,
  }),
}));

// Lazy imports so mocks are in place
async function getMocks() {
  const { appendSignalToInbox } = await import(
    "@terragon/shared/delivery-loop/store/signal-inbox-store"
  );
  const { runCoordinatorTick } = await import("../../coordinator/tick");
  return {
    appendSignalToInbox: appendSignalToInbox as ReturnType<typeof vi.fn>,
    runCoordinatorTick: runCoordinatorTick as ReturnType<typeof vi.fn>,
  };
}

const fakeDb = { insert: vi.fn() } as any;
const workflowId = "wf-test" as WorkflowId;

function basePayload(
  overrides: Partial<DaemonEventPayload> = {},
): DaemonEventPayload {
  return {
    threadId: "thread-1",
    loopId: "loop-1",
    runId: "run-1",
    status: "completed",
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════
// Part 1 — normalizeDaemonEvent (pure)
// ════════════════════════════════════════════════════════════════════════
describe("normalizeDaemonEvent", () => {
  it("completed with no remaining tasks → run_completed / success", () => {
    const signal = normalizeDaemonEvent(
      basePayload({ headSha: "abc123", summary: "done" }),
    );
    expect(signal).toEqual({
      source: "daemon",
      event: {
        kind: "run_completed",
        runId: "run-1",
        result: { kind: "success", headSha: "abc123", summary: "done" },
      },
    });
  });

  it("completed with remainingTasks > 0 → run_completed / partial", () => {
    const signal = normalizeDaemonEvent(
      basePayload({ remainingTasks: 3, headSha: "sha1", summary: "partial" }),
    );
    expect(signal.source).toBe("daemon");
    expect(signal.event.kind).toBe("run_completed");
    const ev = signal.event as any;
    expect(ev.result.kind).toBe("partial");
    expect(ev.result.remainingTasks).toBe(3);
  });

  it("completed preserves headSha and summary", () => {
    const signal = normalizeDaemonEvent(
      basePayload({ headSha: "deadbeef", summary: "all tasks" }),
    );
    const ev = signal.event as any;
    expect(ev.result.headSha).toBe("deadbeef");
    expect(ev.result.summary).toBe("all tasks");
  });

  it("completed defaults headSha and summary to empty string", () => {
    const signal = normalizeDaemonEvent(basePayload());
    const ev = signal.event as any;
    expect(ev.result.headSha).toBe("");
    expect(ev.result.summary).toBe("");
  });

  it("failed → run_failed with runtime_crash, exitCode, message", () => {
    const signal = normalizeDaemonEvent(
      basePayload({
        status: "failed",
        exitCode: 1,
        errorMessage: "segfault",
      }),
    );
    expect(signal).toEqual({
      source: "daemon",
      event: {
        kind: "run_failed",
        runId: "run-1",
        failure: { kind: "runtime_crash", exitCode: 1, message: "segfault" },
      },
    });
  });

  it("failed with null exitCode → exitCode is null", () => {
    const signal = normalizeDaemonEvent(
      basePayload({ status: "failed", exitCode: null }),
    );
    const ev = signal.event as any;
    expect(ev.failure.exitCode).toBeNull();
    expect(ev.failure.kind).toBe("runtime_crash");
  });

  it("failed defaults errorMessage to 'Unknown error'", () => {
    const signal = normalizeDaemonEvent(basePayload({ status: "failed" }));
    const ev = signal.event as any;
    expect(ev.failure.message).toBe("Unknown error");
  });

  it("stopped → human signal with stop_requested", () => {
    const signal = normalizeDaemonEvent(basePayload({ status: "stopped" }));
    expect(signal.source).toBe("human");
    expect(signal.event.kind).toBe("stop_requested");
  });

  it("stopped source is human, NOT daemon", () => {
    const signal = normalizeDaemonEvent(basePayload({ status: "stopped" }));
    expect(signal.source).not.toBe("daemon");
    expect(signal.source).toBe("human");
  });

  it("progress → progress_reported with completedTasks, totalTasks, currentTask", () => {
    const signal = normalizeDaemonEvent(
      basePayload({
        status: "progress",
        completedTasks: 2,
        totalTasks: 5,
        currentTask: "lint",
      }),
    );
    expect(signal).toEqual({
      source: "daemon",
      event: {
        kind: "progress_reported",
        runId: "run-1",
        progress: { completedTasks: 2, totalTasks: 5, currentTask: "lint" },
      },
    });
  });

  it("progress defaults missing fields", () => {
    const signal = normalizeDaemonEvent(basePayload({ status: "progress" }));
    const ev = signal.event as any;
    expect(ev.progress.completedTasks).toBe(0);
    expect(ev.progress.totalTasks).toBe(0);
    expect(ev.progress.currentTask).toBeNull();
  });

  it("each status produces the correct source field", () => {
    const cases: Array<{
      status: DaemonEventPayload["status"];
      expectedSource: string;
    }> = [
      { status: "completed", expectedSource: "daemon" },
      { status: "failed", expectedSource: "daemon" },
      { status: "stopped", expectedSource: "human" },
      { status: "progress", expectedSource: "daemon" },
    ];
    for (const { status, expectedSource } of cases) {
      const signal = normalizeDaemonEvent(basePayload({ status }));
      expect(signal.source).toBe(expectedSource);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// Part 2 — handleDaemonIngress
// ════════════════════════════════════════════════════════════════════════
describe("handleDaemonIngress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("completed event → appends signal with daemon_run_completed causeType", async () => {
    const { appendSignalToInbox } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload(),
      workflowId,
    });
    expect(appendSignalToInbox).toHaveBeenCalledOnce();
    expect(appendSignalToInbox).toHaveBeenCalledWith(
      expect.objectContaining({ causeType: "daemon_run_completed" }),
    );
  });

  it("failed event → appends with daemon_run_failed causeType", async () => {
    const { appendSignalToInbox } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ status: "failed", exitCode: 1 }),
      workflowId,
    });
    expect(appendSignalToInbox).toHaveBeenCalledWith(
      expect.objectContaining({ causeType: "daemon_run_failed" }),
    );
  });

  it("progress event → appends with daemon_progress causeType", async () => {
    const { appendSignalToInbox } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({
        status: "progress",
        completedTasks: 1,
        totalTasks: 3,
      }),
      workflowId,
    });
    expect(appendSignalToInbox).toHaveBeenCalledWith(
      expect.objectContaining({ causeType: "daemon_progress" }),
    );
  });

  it("stopped event → appends with human_stop causeType", async () => {
    const { appendSignalToInbox } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ status: "stopped" }),
      workflowId,
    });
    expect(appendSignalToInbox).toHaveBeenCalledWith(
      expect.objectContaining({ causeType: "human_stop" }),
    );
  });

  it("progress canonical cause ID is dedup-friendly (task snapshot)", async () => {
    const { appendSignalToInbox } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({
        status: "progress",
        completedTasks: 2,
        totalTasks: 5,
        currentTask: "lint",
      }),
      workflowId,
    });
    const call = appendSignalToInbox.mock.calls[0]![0];
    expect(call.canonicalCauseId).toBe("daemon:run-1:progress:2:5:lint");
  });

  it("progress with missing currentTask uses 'none' in canonical ID", async () => {
    const { appendSignalToInbox } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({
        status: "progress",
        completedTasks: 0,
        totalTasks: 3,
      }),
      workflowId,
    });
    const call = appendSignalToInbox.mock.calls[0]![0];
    expect(call.canonicalCauseId).toContain(":none");
  });

  it("partial completion → canonical cause ID ends with :partial", async () => {
    const { appendSignalToInbox } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ remainingTasks: 2 }),
      workflowId,
    });
    const call = appendSignalToInbox.mock.calls[0]![0];
    expect(call.canonicalCauseId).toMatch(/:partial$/);
  });

  it("terminal completion → canonical cause ID ends with :terminal", async () => {
    const { appendSignalToInbox } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ remainingTasks: 0 }),
      workflowId,
    });
    const call = appendSignalToInbox.mock.calls[0]![0];
    expect(call.canonicalCauseId).toMatch(/:terminal$/);
  });

  it("completed with no remainingTasks → canonical cause ID ends with :terminal", async () => {
    const { appendSignalToInbox } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload(), // no remainingTasks field
      workflowId,
    });
    const call = appendSignalToInbox.mock.calls[0]![0];
    expect(call.canonicalCauseId).toMatch(/:terminal$/);
  });

  it("circuit breaker: consecutiveDispatches >= 7 → selfDispatch is null", async () => {
    const { runCoordinatorTick } = await getMocks();
    runCoordinatorTick.mockResolvedValueOnce({
      workflowId,
      correlationId: "c-1",
      signalsProcessed: 1,
      transitioned: true,
      stateBefore: "implementing",
      stateAfter: "implementing",
      workItemsScheduled: 1,
      incidentsEvaluated: false,
    });
    const result = await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload(),
      workflowId,
      consecutiveDispatches: 7,
    });
    expect(result.selfDispatch).toBeNull();
    // tick should still be called
    expect(runCoordinatorTick).toHaveBeenCalledOnce();
  });

  it("circuit breaker: consecutiveDispatches < 7 → tick runs, selfDispatch still null (TODO path)", async () => {
    const { runCoordinatorTick } = await getMocks();
    runCoordinatorTick.mockResolvedValueOnce({
      workflowId,
      correlationId: "c-1",
      signalsProcessed: 1,
      transitioned: true,
      stateBefore: "implementing",
      stateAfter: "implementing",
      workItemsScheduled: 1,
      incidentsEvaluated: false,
    });
    const result = await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload(),
      workflowId,
      consecutiveDispatches: 3,
    });
    // Currently returns null because the TODO payload construction isn't wired
    expect(result.selfDispatch).toBeNull();
    expect(runCoordinatorTick).toHaveBeenCalledOnce();
  });

  it("tick is NOT called for non-completed events (failed)", async () => {
    const { runCoordinatorTick } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ status: "failed" }),
      workflowId,
    });
    expect(runCoordinatorTick).not.toHaveBeenCalled();
  });

  it("tick is NOT called for stopped events", async () => {
    const { runCoordinatorTick } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ status: "stopped" }),
      workflowId,
    });
    expect(runCoordinatorTick).not.toHaveBeenCalled();
  });

  it("tick is NOT called for progress events", async () => {
    const { runCoordinatorTick } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ status: "progress" }),
      workflowId,
    });
    expect(runCoordinatorTick).not.toHaveBeenCalled();
  });

  it("tick error → caught and logged, returns {selfDispatch: null}", async () => {
    const { runCoordinatorTick } = await getMocks();
    runCoordinatorTick.mockRejectedValueOnce(new Error("tick boom"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload(),
      workflowId,
    });
    expect(result).toEqual({ selfDispatch: null });
    expect(warnSpy).toHaveBeenCalledWith(
      "[daemon-ingress] self-dispatch micro-tick failed",
      expect.objectContaining({ workflowId, runId: "run-1" }),
    );
    warnSpy.mockRestore();
  });

  it("passes loopId (not workflowId) as inbox partition key", async () => {
    const { appendSignalToInbox } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ loopId: "v1-loop-42" }),
      workflowId,
    });
    expect(appendSignalToInbox).toHaveBeenCalledWith(
      expect.objectContaining({ loopId: "v1-loop-42" }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// Part 3 — isEligibleForSelfDispatch (not exported, tested indirectly)
// ════════════════════════════════════════════════════════════════════════
describe("isEligibleForSelfDispatch (indirect)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("daemon + run_completed → tick IS called (eligible)", async () => {
    const { runCoordinatorTick } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ status: "completed" }),
      workflowId,
    });
    expect(runCoordinatorTick).toHaveBeenCalledOnce();
  });

  it("daemon + run_failed → tick NOT called (ineligible)", async () => {
    const { runCoordinatorTick } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ status: "failed" }),
      workflowId,
    });
    expect(runCoordinatorTick).not.toHaveBeenCalled();
  });

  it("human + stop_requested → tick NOT called (ineligible)", async () => {
    const { runCoordinatorTick } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ status: "stopped" }),
      workflowId,
    });
    expect(runCoordinatorTick).not.toHaveBeenCalled();
  });

  it("daemon + progress_reported → tick NOT called (ineligible)", async () => {
    const { runCoordinatorTick } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ status: "progress" }),
      workflowId,
    });
    expect(runCoordinatorTick).not.toHaveBeenCalled();
  });
});
