import { describe, expect, it } from "vitest";
import { reduce } from "./reducer";
import type { WorkflowHead } from "./types";

function head(state: WorkflowHead["state"]): WorkflowHead {
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

describe("reduce", () => {
  it("planning bootstrap stays in planning and dispatches planning run", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: head("planning"),
      event: { type: "bootstrap" },
      now,
    });

    expect(result.head.state).toBe("planning");
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]).toMatchObject({
      kind: "dispatch_implementing",
      payload: {
        kind: "dispatch_implementing",
        executionClass: "implementation_runtime",
      },
    });
    expect(result.effects[1]).toMatchObject({
      kind: "publish_status",
      payload: { kind: "publish_status" },
    });
  });

  it("plan_completed transitions to implementing without plan artifact", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: head("planning"),
      event: { type: "plan_completed" },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.effects).toHaveLength(2);
    expect(
      result.effects.find((e) => e.kind === "dispatch_implementing"),
    ).toMatchObject({
      kind: "dispatch_implementing",
    });
    expect(
      result.effects.find((e) => e.kind === "publish_status"),
    ).toMatchObject({
      kind: "publish_status",
    });
  });

  it("planning_run_completed stays in planning and emits create_plan_artifact", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: head("planning"),
      event: { type: "planning_run_completed" },
      now,
    });

    expect(result.head.state).toBe("planning");
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]).toMatchObject({
      kind: "create_plan_artifact",
      payload: { kind: "create_plan_artifact" },
    });
    expect(result.effects[1]).toMatchObject({
      kind: "publish_status",
      payload: { kind: "publish_status" },
    });
  });

  it("planning_run_completed is idempotent (no-op from non-planning state)", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: head("implementing"),
      event: { type: "planning_run_completed" },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.effects).toHaveLength(0);
  });

  it("planning dispatch_sent stays in planning and arms ack timeout", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const ackDeadlineAt = new Date("2026-03-18T01:01:30.000Z");
    const result = reduce({
      head: head("planning"),
      event: {
        type: "dispatch_sent",
        runId: "run-bootstrap",
        ackDeadlineAt,
      },
      now,
    });

    expect(result.head.state).toBe("planning");
    expect(result.head.activeRunId).toBe("run-bootstrap");
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({
      kind: "ack_timeout_check",
      dueAt: ackDeadlineAt,
      payload: {
        kind: "ack_timeout_check",
        runId: "run-bootstrap",
      },
    });
  });

  it("gating_review dispatch_sent arms ack timeout check", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const ackDeadlineAt = new Date("2026-03-18T01:01:30.000Z");
    const result = reduce({
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
    const result = reduce({
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
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]?.kind).toBe("dispatch_implementing");
    expect(result.effects[1]?.kind).toBe("publish_status");
  });

  it("review dispatch ack timeout uses infra retry lane", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
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
    const result = reduce({
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
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]?.kind).toBe("dispatch_implementing");
    expect(result.effects[0]?.payload).toMatchObject({
      kind: "dispatch_implementing",
      executionClass: "implementation_runtime",
    });
    expect(result.effects[1]?.kind).toBe("publish_status");
  });

  it("implementing run_completed without activeRunId still resolves to gate_review", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
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
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]?.kind).toBe("dispatch_gate_review");
    expect(result.effects[1]?.kind).toBe("publish_status");
    expect(result.head.headSha).toBe("sha-early");
  });

  it("implementing run_failed without activeRunId still retries", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
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
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]?.payload).toMatchObject({
      kind: "dispatch_implementing",
      executionClass: "implementation_runtime_fallback",
    });
    expect(result.effects[1]?.kind).toBe("publish_status");
  });

  it("infra run_failed from planning/implementing falls back to secondary runtime", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
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

  it("implementing run_failed with mismatched runId still triggers retry", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
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

    expect(result.head.state).toBe("implementing");
    expect(result.head.fixAttemptCount).toBe(3);
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]?.kind).toBe("dispatch_implementing");
    expect(result.effects[1]?.kind).toBe("publish_status");
  });

  it("ignores stale review gate verdict for non-current run", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
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

  it("ignores review gate verdicts without runId while a run is active", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("gating_review"),
        activeGate: "review",
        activeRunId: "run-current",
      },
      event: {
        type: "gate_review_passed",
      },
      now,
    });

    expect(result.head.state).toBe("gating_review");
    expect(result.head.activeRunId).toBe("run-current");
    expect(result.effects).toHaveLength(0);
  });

  it("gate_review_passed clears active run before entering CI gate", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("gating_review"),
        activeGate: "review",
        activeRunId: "run-review",
      },
      event: {
        type: "gate_review_passed",
        runId: "run-review",
        prNumber: 42,
      },
      now,
    });

    expect(result.head.state).toBe("gating_ci");
    expect(result.head.activeGate).toBe("ci");
    expect(result.head.activeRunId).toBeNull();
  });

  it("gate_review_passed without linked PR transitions to awaiting_pr", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("gating_review"),
        activeGate: "review",
        activeRunId: "run-review",
      },
      event: {
        type: "gate_review_passed",
        runId: "run-review",
        prNumber: null,
      },
      now,
    });

    expect(result.head.state).toBe("awaiting_pr");
    expect(result.head.activeGate).toBeNull();
    expect(result.head.activeRunId).toBeNull();
    expect(result.head.blockedReason).toBe("Awaiting PR creation");
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]).toMatchObject({
      kind: "ensure_pr",
      payload: { kind: "ensure_pr" },
    });
    expect(result.effects[1]).toMatchObject({
      kind: "publish_status",
      payload: { kind: "publish_status" },
    });
  });

  it("awaiting_pr with PR-creation marker re-enters CI gate on pr_linked", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("awaiting_pr"),
        blockedReason: "Awaiting PR creation",
      },
      event: {
        type: "pr_linked",
        prNumber: 42,
      },
      now,
    });

    expect(result.head.state).toBe("gating_ci");
    expect(result.head.activeGate).toBe("ci");
    expect(result.head.blockedReason).toBeNull();
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]).toMatchObject({
      kind: "gate_staleness_check",
      payload: { kind: "gate_staleness_check" },
    });
    expect(result.effects[1]).toMatchObject({
      kind: "publish_status",
      payload: { kind: "publish_status" },
    });
  });

  it("gating_ci entry emits gate_staleness_check with 5-minute dueAt", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("awaiting_pr"),
        blockedReason: "Awaiting PR creation",
      },
      event: {
        type: "pr_linked",
        prNumber: 99,
      },
      now,
    });

    expect(result.head.state).toBe("gating_ci");
    const stalenessEffect = result.effects.find(
      (e) => e.kind === "gate_staleness_check",
    );
    expect(stalenessEffect).toBeDefined();
    expect(stalenessEffect!.dueAt).toEqual(
      new Date("2026-03-18T01:05:00.000Z"),
    );
    expect(stalenessEffect).toMatchObject({
      kind: "gate_staleness_check",
      payload: { kind: "gate_staleness_check" },
    });
  });

  it("awaiting_pr without PR-creation marker ignores pr_linked", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("awaiting_pr"),
        blockedReason: null,
      },
      event: {
        type: "pr_linked",
        prNumber: 42,
      },
      now,
    });

    expect(result.head.state).toBe("awaiting_pr");
    expect(result.effects).toHaveLength(0);
  });

  it("awaiting_pr retries implementing when PR linkage fails", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("awaiting_pr"),
        blockedReason: "Awaiting PR creation",
      },
      event: {
        type: "gate_review_failed",
        reason: "No code changes detected to open PR",
      },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.head.fixAttemptCount).toBe(1);
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]).toMatchObject({
      kind: "dispatch_implementing",
      payload: {
        kind: "dispatch_implementing",
        executionClass: "implementation_runtime",
      },
    });
    expect(result.effects[1]).toMatchObject({
      kind: "publish_status",
      payload: { kind: "publish_status" },
    });
  });

  it("dispatch coherence clears stale activeRunId in non-dispatch state", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
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
    const result = reduce({
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

  it("ignores stale CI verdicts with mismatched headSha", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("gating_ci"),
        activeGate: "ci",
        headSha: "sha-current",
      },
      event: {
        type: "gate_ci_passed",
        headSha: "sha-stale",
      },
      now,
    });

    expect(result.head.state).toBe("gating_ci");
    expect(result.head.headSha).toBe("sha-current");
    expect(result.effects).toHaveLength(0);
  });

  it("ignores uncorrelated CI verdicts when headSha is missing", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("gating_ci"),
        activeGate: "ci",
        headSha: "sha-current",
      },
      event: {
        type: "gate_ci_failed",
        reason: "CI checks failed",
      },
      now,
    });

    expect(result.head.state).toBe("gating_ci");
    expect(result.effects).toHaveLength(0);
  });

  it("accepts correlated CI pass and transitions to awaiting_pr", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("gating_ci"),
        activeGate: "ci",
        headSha: "sha-current",
      },
      event: {
        type: "gate_ci_passed",
        headSha: "sha-current",
      },
      now,
    });

    expect(result.head.state).toBe("awaiting_pr");
    expect(result.head.activeGate).toBeNull();
    expect(result.head.activeRunId).toBeNull();
  });

  it("normalizes terminal states through invariants", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("done"),
        activeGate: "ci",
        activeRunId: "run-stale",
      },
      event: {
        type: "run_failed",
        runId: "run-stale",
        message: "late error",
        category: null,
      },
      now,
    });

    expect(result.head.state).toBe("done");
    expect(result.head.activeGate).toBeNull();
    expect(result.head.activeRunId).toBeNull();
  });

  it("normalizes stop_requested terminal transition", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("gating_ci"),
        activeGate: "review",
        activeRunId: "run-stale",
        headSha: "sha-current",
      },
      event: {
        type: "stop_requested",
      },
      now,
    });

    expect(result.head.state).toBe("stopped");
    expect(result.head.activeGate).toBeNull();
    expect(result.head.activeRunId).toBeNull();
  });

  describe("implementing state accepts mismatched runIds", () => {
    const NOW = new Date("2026-03-18T01:00:00.000Z");

    it("run_completed with different runId transitions to gating_review", () => {
      const h = { ...head("implementing"), activeRunId: "r-1" };
      const result = reduce({
        head: h,
        event: {
          type: "run_completed",
          runId: "r-different",
          headSha: "abc123",
        },
        now: NOW,
      });
      expect(result.head.state).toBe("gating_review");
    });

    it("dispatch_acked with different runId is dropped (out-of-order guard)", () => {
      const h = { ...head("implementing"), activeRunId: "r-1" };
      const result = reduce({
        head: h,
        event: { type: "dispatch_acked", runId: "r-2" },
        now: NOW,
      });
      expect(result.head.state).toBe("implementing");
      expect(result.head.activeRunId).toBe("r-1");
    });

    it("run_failed with different runId triggers retry", () => {
      const h = { ...head("implementing"), activeRunId: "r-1" };
      const result = reduce({
        head: h,
        event: {
          type: "run_failed",
          runId: "r-different",
          message: "crash",
          category: null,
        },
        now: NOW,
      });
      expect(result.head.state).toBe("implementing");
    });

    it("dispatch_ack_timeout with different runId is ignored (stale)", () => {
      const h = { ...head("implementing"), activeRunId: "r-1" };
      const result = reduce({
        head: h,
        event: { type: "dispatch_ack_timeout", runId: "r-old" },
        now: NOW,
      });
      expect(result.head.state).toBe("implementing");
      expect(result.head.version).toBe(h.version);
    });
  });
});
