import { describe, expect, it } from "vitest";
import { reduceV3 } from "./reducer";
import type { WorkflowHeadV3 } from "./types";

function head(state: WorkflowHeadV3["state"]): WorkflowHeadV3 {
  const now = new Date("2026-03-18T00:00:00.000Z");
  return {
    workflowId: "wf-1",
    threadId: "thread-1",
    generation: 1,
    version: 2,
    state,
    activeGate: null,
    headSha: null,
    activeRunId: null,
    fixAttemptCount: 0,
    infraRetryCount: 0,
    maxFixAttempts: 6,
    maxInfraRetries: 10,
    blockedReason: null,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  };
}

describe("reduceV3", () => {
  it("planning bootstrap schedules implementation dispatch", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduceV3({
      head: head("planning"),
      event: { type: "bootstrap" },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({
      kind: "dispatch_implementing",
      payload: {
        kind: "dispatch_implementing",
        executionClass: "implementation_runtime",
      },
    });
  });

  it("gating_review dispatch_sent arms ack timeout check", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const ackDeadlineAt = new Date("2026-03-18T01:01:30.000Z");
    const result = reduceV3({
      head: {
        ...head("gating_review"),
        activeGate: "review",
      },
      event: {
        type: "dispatch_sent",
        runId: "run-1",
        ackDeadlineAt,
      },
      now,
    });

    expect(result.head.activeRunId).toBe("run-1");
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({
      kind: "ack_timeout_check",
      dueAt: ackDeadlineAt,
      payload: {
        kind: "ack_timeout_check",
        runId: "run-1",
      },
    });
  });

  it("review failure transitions back to implementing and increments fix attempts", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduceV3({
      head: {
        ...head("gating_review"),
        activeGate: "review",
        fixAttemptCount: 2,
      },
      event: {
        type: "gate_review_failed",
        reason: "Requested changes",
      },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.head.fixAttemptCount).toBe(3);
    expect(result.effects).toHaveLength(1);
    const [effect] = result.effects;
    expect(effect?.kind).toBe("dispatch_implementing");
  });

  it("review dispatch ack timeout uses infra retry lane", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduceV3({
      head: {
        ...head("gating_review"),
        activeGate: "review",
        infraRetryCount: 1,
      },
      event: {
        type: "dispatch_ack_timeout",
        runId: "run-2",
      },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.head.infraRetryCount).toBe(2);
    expect(result.head.fixAttemptCount).toBe(0);
  });

  it("implementing run_completed without head SHA retries implementation", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduceV3({
      head: head("implementing"),
      event: {
        type: "run_completed",
        runId: "run-no-sha",
        headSha: null,
      },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.head.fixAttemptCount).toBe(1);
    expect(result.head.blockedReason).toBeNull();
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]?.kind).toBe("dispatch_implementing");
    expect(result.effects[0]?.payload).toMatchObject({
      kind: "dispatch_implementing",
      executionClass: "implementation_runtime",
    });
  });

  it("implementing run_completed without activeRunId still resolves to gate_review", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduceV3({
      head: {
        ...head("implementing"),
        activeRunId: null,
      },
      event: {
        type: "run_completed",
        runId: "run-early",
        headSha: "sha-early",
      },
      now,
    });

    expect(result.head.state).toBe("gating_review");
    expect(result.head.activeRunId).toBeNull();
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]?.kind).toBe("dispatch_gate_review");
    expect(result.head.headSha).toBe("sha-early");
  });

  it("implementing run_failed without activeRunId still retries", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduceV3({
      head: {
        ...head("implementing"),
        activeRunId: null,
      },
      event: {
        type: "run_failed",
        runId: "run-early",
        message: "Internal error",
        category: "runtime_crash",
      },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.head.fixAttemptCount).toBe(0);
    expect(result.head.infraRetryCount).toBe(1);
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]?.payload).toMatchObject({
      kind: "dispatch_implementing",
      executionClass: "implementation_runtime_fallback",
    });
  });

  it("infra run_failed from planning/implementing falls back to secondary runtime", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduceV3({
      head: {
        ...head("gating_review"),
        activeGate: "review",
        infraRetryCount: 2,
      },
      event: {
        type: "run_failed",
        runId: "run-review",
        message: "couldn't connect to server",
        category: "transport",
      },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.head.fixAttemptCount).toBe(0);
    expect(result.head.infraRetryCount).toBe(3);
    expect(result.effects[0]?.payload).toMatchObject({
      kind: "dispatch_implementing",
      executionClass: "implementation_runtime_fallback",
    });
  });

  it("ignores stale implementing run_failed for previous run", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduceV3({
      head: {
        ...head("implementing"),
        activeRunId: "run-current",
        fixAttemptCount: 2,
      },
      event: {
        type: "run_failed",
        runId: "run-stale",
        message: "Old run failed",
        category: null,
      },
      now,
    });

    expect(result.head).toMatchObject({
      state: "implementing",
      activeRunId: "run-current",
      fixAttemptCount: 2,
    });
    expect(result.effects).toHaveLength(0);
  });

  it("ignores stale review gate verdict for non-current run", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduceV3({
      head: {
        ...head("gating_review"),
        activeGate: "review",
        activeRunId: "run-current",
      },
      event: {
        type: "gate_review_failed",
        runId: "run-stale",
        reason: "Bad review",
      },
      now,
    });

    expect(result.head.state).toBe("gating_review");
    expect(result.head.activeRunId).toBe("run-current");
    expect(result.effects).toHaveLength(0);
  });

  it("gate_review_passed clears active run before entering CI gate", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduceV3({
      head: {
        ...head("gating_review"),
        activeGate: "review",
        activeRunId: "run-review",
      },
      event: {
        type: "gate_review_passed",
        runId: "run-review",
      },
      now,
    });

    expect(result.head.state).toBe("gating_ci");
    expect(result.head.activeGate).toBe("ci");
    expect(result.head.activeRunId).toBeNull();
  });

  it("dispatch coherence clears stale activeRunId in non-dispatch state", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduceV3({
      head: {
        ...head("awaiting_manual_fix"),
        activeRunId: "run-stale",
      },
      event: {
        type: "run_completed",
        runId: "run-completed",
        headSha: "sha-1",
      },
      now,
    });

    expect(result.head.state).toBe("awaiting_manual_fix");
    expect(result.head.activeRunId).toBeNull();
    expect(result.effects).toHaveLength(0);
    expect(result.invariantActions).toHaveLength(1);
    expect(result.invariantActions[0]?.kind).toBe("dispatch_coherence");
    expect(result.invariantActions[0]!).toMatchObject({
      fromActiveRunId: "run-stale",
      toActiveRunId: null,
    });
  });

  it("branch coherence normalizes unexpected gate in gating_review", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduceV3({
      head: {
        ...head("gating_review"),
        activeGate: "ci",
      },
      event: {
        type: "dispatch_acked",
        runId: "run-1",
      },
      now,
    });

    expect(result.head.state).toBe("gating_review");
    expect(result.head.activeGate).toBe("review");
    expect(result.invariantActions).toHaveLength(1);
    expect(result.invariantActions[0]?.kind).toBe("branch_coherence");
    expect(result.invariantActions[0]!).toMatchObject({
      fromActiveGate: "ci",
      toActiveGate: "review",
    });
  });
});
