import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DaemonEventPayload } from "./daemon-ingress";
import { normalizeDaemonEvent, handleDaemonIngress } from "./daemon-ingress";
import type { DB } from "@terragon/shared/db";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";
import type {
  DaemonOutcome,
  DaemonEnvelopeContext,
} from "@terragon/shared/delivery-loop/domain/outcomes";

// ── mocks ──────────────────────────────────────────────────────────────
vi.mock("@terragon/shared/delivery-loop/store/signal-inbox-store", () => ({
  appendSignalToInbox: vi.fn().mockResolvedValue([{ id: "sig-1" }]),
}));

vi.mock("../../v3/store", () => ({
  appendJournalEventV3: vi
    .fn()
    .mockResolvedValue({ inserted: true, id: "j-1" }),
  enqueueOutboxRecordV3: vi
    .fn()
    .mockResolvedValue({ inserted: true, id: "o-1" }),
}));

// Lazy imports so mocks are in place
async function getMocks() {
  const { appendSignalToInbox } = await import(
    "@terragon/shared/delivery-loop/store/signal-inbox-store"
  );
  const { appendJournalEventV3, enqueueOutboxRecordV3 } = await import(
    "../../v3/store"
  );
  return {
    appendSignalToInbox: appendSignalToInbox as ReturnType<typeof vi.fn>,
    appendJournalEventV3: appendJournalEventV3 as ReturnType<typeof vi.fn>,
    enqueueOutboxRecordV3: enqueueOutboxRecordV3 as ReturnType<typeof vi.fn>,
  };
}

const fakeDb = {
  insert: vi.fn(),
  transaction: vi.fn(),
} as unknown as DB;
(
  fakeDb as unknown as { transaction: ReturnType<typeof vi.fn> }
).transaction.mockImplementation(async (fn: (db: DB) => Promise<unknown>) =>
  fn(fakeDb),
);
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
    const ev = signal.event;
    if (ev.kind !== "run_completed") {
      throw new Error("expected run_completed event");
    }
    expect(ev.result.kind).toBe("partial");
    if (ev.result.kind !== "partial") {
      throw new Error("expected partial completion result");
    }
    expect(ev.result.remainingTasks).toBe(3);
  });

  it("completed preserves headSha and summary", () => {
    const signal = normalizeDaemonEvent(
      basePayload({ headSha: "deadbeef", summary: "all tasks" }),
    );
    const ev = signal.event;
    if (ev.kind !== "run_completed") {
      throw new Error("expected run_completed event");
    }
    expect(ev.result.headSha).toBe("deadbeef");
    expect(ev.result.summary).toBe("all tasks");
  });

  it("completed defaults headSha and summary to empty string", () => {
    const signal = normalizeDaemonEvent(basePayload());
    const ev = signal.event;
    if (ev.kind !== "run_completed") {
      throw new Error("expected run_completed event");
    }
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
    const ev = signal.event;
    if (ev.kind !== "run_failed") {
      throw new Error("expected run_failed event");
    }
    if (ev.failure.kind !== "runtime_crash") {
      throw new Error("expected runtime_crash failure");
    }
    expect(ev.failure.exitCode).toBeNull();
    expect(ev.failure.kind).toBe("runtime_crash");
  });

  it("failed defaults errorMessage to 'Unknown error'", () => {
    const signal = normalizeDaemonEvent(basePayload({ status: "failed" }));
    const ev = signal.event;
    if (ev.kind !== "run_failed") {
      throw new Error("expected run_failed event");
    }
    if (ev.failure.kind !== "runtime_crash") {
      throw new Error("expected runtime_crash failure");
    }
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
    const ev = signal.event;
    if (ev.kind !== "progress_reported") {
      throw new Error("expected progress_reported event");
    }
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
    const tx = fakeDb as unknown as { transaction: ReturnType<typeof vi.fn> };
    tx.transaction.mockImplementation(
      async (fn: (db: DB) => Promise<unknown>) => fn(fakeDb),
    );
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

  it("writes inbox + journal + outbox in a single transaction", async () => {
    const { appendSignalToInbox, appendJournalEventV3, enqueueOutboxRecordV3 } =
      await getMocks();
    const tx = fakeDb as unknown as { transaction: ReturnType<typeof vi.fn> };

    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload(),
      workflowId,
    });

    expect(tx.transaction).toHaveBeenCalledOnce();
    expect(appendSignalToInbox).toHaveBeenCalledOnce();
    expect(appendJournalEventV3).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId,
        source: "daemon",
        eventType: "run_completed",
      }),
    );
    expect(enqueueOutboxRecordV3).toHaveBeenCalledWith(
      expect.objectContaining({
        outbox: expect.objectContaining({
          workflowId,
          topic: "signal",
        }),
      }),
    );
  });

  it("does not enqueue outbox row when journal dedupe detects duplicate", async () => {
    const { appendJournalEventV3, enqueueOutboxRecordV3 } = await getMocks();
    appendJournalEventV3.mockResolvedValueOnce({ inserted: false, id: null });

    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload(),
      workflowId,
    });

    expect(enqueueOutboxRecordV3).not.toHaveBeenCalled();
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

  it("completed events no longer schedule legacy self-dispatch", async () => {
    const result = await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload(),
      workflowId,
    });
    expect(result.selfDispatch).toBeNull();
    expect(result.workItemsScheduled).toBe(0);
  });

  it("does not wake the coordinator for non-completed events (failed)", async () => {
    const { appendSignalToInbox } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ status: "failed" }),
      workflowId,
    });
    expect(appendSignalToInbox).toHaveBeenCalledOnce();
  });

  it("does not wake the coordinator for stopped events", async () => {
    const { appendSignalToInbox } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ status: "stopped" }),
      workflowId,
    });
    expect(appendSignalToInbox).toHaveBeenCalledOnce();
  });

  it("does not wake the coordinator for progress events", async () => {
    const { appendSignalToInbox } = await getMocks();
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ status: "progress" }),
      workflowId,
    });
    expect(appendSignalToInbox).toHaveBeenCalledOnce();
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
// Part 4 — DaemonOutcome (backward compatibility & metadata preservation)
// ════════════════════════════════════════════════════════════════════════
describe("handleDaemonIngress with DaemonOutcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseEnvelope: DaemonEnvelopeContext = {
    eventId: "evt-1",
    seq: 3,
    runId: "run-1",
    contextUsage: 42000,
  };

  it("backward compatible — works without outcome parameter", async () => {
    const { appendSignalToInbox } = await getMocks();
    const result = await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload(),
      workflowId,
    });
    expect(appendSignalToInbox).toHaveBeenCalledOnce();
    expect(result.selfDispatch).toBeNull();
  });

  it("accepts completion outcome without changing signal behavior", async () => {
    const { appendSignalToInbox } = await getMocks();
    const outcome: DaemonOutcome = {
      kind: "completion",
      envelope: baseEnvelope,
      result: { kind: "success", headSha: "abc", summary: "done" },
      headSha: "abc",
      summary: "done",
    };
    const result = await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload(),
      workflowId,
      outcome,
    });
    // Signal still appended normally
    expect(appendSignalToInbox).toHaveBeenCalledOnce();
    expect(appendSignalToInbox).toHaveBeenCalledWith(
      expect.objectContaining({ causeType: "daemon_run_completed" }),
    );
    // Return shape unchanged
    expect(result).toHaveProperty("selfDispatch");
    expect(result).toHaveProperty("workItemsScheduled");
  });

  it("accepts failure outcome without changing signal behavior", async () => {
    const { appendSignalToInbox } = await getMocks();
    const outcome: DaemonOutcome = {
      kind: "failure",
      envelope: baseEnvelope,
      errorMessage: "segfault",
      errorCategory: "daemon_custom_error",
      failureCategory: "claude_runtime_exit",
      exitCode: 1,
    };
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({
        status: "failed",
        exitCode: 1,
        errorMessage: "segfault",
      }),
      workflowId,
      outcome,
    });
    expect(appendSignalToInbox).toHaveBeenCalledWith(
      expect.objectContaining({ causeType: "daemon_run_failed" }),
    );
  });

  it("accepts user_stop outcome without changing signal behavior", async () => {
    const { appendSignalToInbox } = await getMocks();
    const outcome: DaemonOutcome = {
      kind: "user_stop",
      envelope: baseEnvelope,
    };
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({ status: "stopped" }),
      workflowId,
      outcome,
    });
    expect(appendSignalToInbox).toHaveBeenCalledWith(
      expect.objectContaining({ causeType: "human_stop" }),
    );
  });

  it("accepts progress outcome without changing signal behavior", async () => {
    const { appendSignalToInbox } = await getMocks();
    const outcome: DaemonOutcome = {
      kind: "progress",
      envelope: baseEnvelope,
      completedTasks: 2,
      totalTasks: 5,
      currentTask: "lint",
    };
    await handleDaemonIngress({
      db: fakeDb,
      rawEvent: basePayload({
        status: "progress",
        completedTasks: 2,
        totalTasks: 5,
        currentTask: "lint",
      }),
      workflowId,
      outcome,
    });
    expect(appendSignalToInbox).toHaveBeenCalledWith(
      expect.objectContaining({ causeType: "daemon_progress" }),
    );
  });
});
