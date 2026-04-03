import { describe, expect, it } from "vitest";
import { reduce } from "./reducer";
import type { WorkflowHead, WorkflowState } from "./types";
import {
  ALL_CANONICAL_EVENTS,
  ALL_STATES,
  BRANCH_CASES,
  CONTRACT_NOW,
  EXPECTED_TRANSITIONS,
  makeContractHead,
} from "./transition-contract";

function head(state: WorkflowHead["state"]): WorkflowHead {
  const now = new Date("2026-03-18T00:00:00.000Z");
  const activeRunSeq =
    state === "awaiting_implementation_acceptance" ||
    state === "implementing" ||
    state === "gating_review" ||
    state === "gating_ci" ||
    state === "awaiting_pr_creation"
      ? 1
      : null;
  const lastTerminalRunSeq = state === "awaiting_pr_lifecycle" ? 1 : null;
  return {
    workflowId: "wf-1",
    threadId: "thread-1",
    generation: 1,
    version: 2,
    state,
    activeGate: null,
    headSha: null,
    activeRunId: null,
    activeRunSeq,
    leaseExpiresAt: null,
    lastTerminalRunSeq,
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
  it("planning bootstrap stays in planning and emits dispatch_implementing + publish_status", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: head("planning"),
      event: { type: "bootstrap" },
      now,
    });

    expect(result.head.state).toBe("planning");
    expect(result.head.activeRunSeq).toBeNull();
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]).toMatchObject({
      kind: "dispatch_implementing",
      payload: { kind: "dispatch_implementing" },
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

  it("scheduling a new implementation attempt allocates the next activeRunSeq", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("awaiting_manual_fix"),
        lastTerminalRunSeq: 4,
      },
      event: { type: "resume_requested" },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.head.activeRunSeq).toBe(5);
    expect(result.head.lastTerminalRunSeq).toBe(4);
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

  it("planning dispatch_sent is a legacy no-op", () => {
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
    expect(result.head.activeRunId).toBeNull();
    expect(result.head.version).toBe(2);
    expect(result.effects).toHaveLength(0);
  });

  it("gating_review dispatch_sent is a legacy no-op", () => {
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

    expect(result.head.state).toBe("gating_review");
    expect(result.head.activeRunId).toBeNull();
    expect(result.head.version).toBe(2);
    expect(result.effects).toHaveLength(0);
  });

  it("review failure transitions to implementing and increments fix attempts", () => {
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

  it("review dispatch ack timeout is ignored in the gate flow", () => {
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

    expect(result.head.state).toBe("gating_review");
    expect(result.head.infraRetryCount).toBe(1);
    expect(result.head.fixAttemptCount).toBe(0);
    expect(result.head.version).toBe(2);
    expect(result.effects).toHaveLength(0);
  });

  it("implementing adopts newer dispatch_queued runId", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const ackDeadlineAt = new Date("2026-03-18T01:01:30.000Z");
    const result = reduce({
      head: {
        ...head("implementing"),
        activeRunId: "run-stale",
      },
      event: {
        type: "dispatch_queued",
        runId: "run-fresh",
        ackDeadlineAt,
      },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.head.activeRunId).toBe("run-fresh");
    expect(result.head.version).toBe(3);
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({
      kind: "ack_timeout_check",
      payload: {
        kind: "ack_timeout_check",
        runId: "run-fresh",
      },
    });
  });

  it("implementing treats dispatch_accepted as a legacy runId refresh", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("implementing"),
        activeRunId: "run-stale",
      },
      event: {
        type: "dispatch_accepted",
        runId: "run-fresh",
      },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.head.activeRunId).toBe("run-fresh");
    expect(result.head.version).toBe(3);
    expect(result.effects).toHaveLength(0);
  });

  it("legacy awaiting_implementation_acceptance heads normalize into implementing", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("awaiting_implementation_acceptance"),
        activeRunId: "run-stale",
      },
      event: {
        type: "dispatch_claimed",
        runId: "run-fresh",
      },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.head.activeRunId).toBe("run-fresh");
    expect(result.head.version).toBe(3);
    expect(result.effects).toHaveLength(0);
  });

  it("implementing run_completed without head SHA retries via implementing", () => {
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
    expect(result.head.blockedReason).toBe("Run completed without head SHA");
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]?.kind).toBe("dispatch_implementing");
    expect(result.effects[0]?.payload).toMatchObject({
      kind: "dispatch_implementing",
      executionClass: "implementation_runtime",
    });
    expect(result.effects[1]?.kind).toBe("publish_status");
  });

  it("run_completed with unchanged headSha is treated as agent failure and returns to implementing", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const h = {
      ...head("implementing"),
      headSha: "sha-before",
      activeRunId: "r-1",
    };
    const result = reduce({
      head: h,
      event: { type: "run_completed", runId: "r-1", headSha: "sha-before" },
      now,
    });
    expect(result.head.state).toBe("implementing"); // retried, not gating_review
    expect(result.head.fixAttemptCount).toBe(1);
    expect(result.head.blockedReason).toBe(
      "Agent completed without making code changes",
    );
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]?.kind).toBe("dispatch_implementing");
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

  it("implementing run_failed without activeRunId retries through implementing", () => {
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

  it("infra run_failed from gating_review falls back to secondary runtime and returns to implementing", () => {
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

  it("implementing run_failed with mismatched runId is ignored", () => {
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
    expect(result.head.fixAttemptCount).toBe(2);
    expect(result.head.version).toBe(2);
    expect(result.effects).toHaveLength(0);
  });

  it("implementing run_completed with mismatched runSeq is ignored even when runId matches", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const h = {
      ...head("implementing"),
      activeRunId: "run-current",
      activeRunSeq: 7,
    };
    const result = reduce({
      head: h,
      event: {
        type: "run_completed",
        runId: "run-current",
        runSeq: 8,
        headSha: "sha-stale",
      },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.head.version).toBe(h.version);
    expect(result.head.activeRunSeq).toBe(7);
    expect(result.effects).toHaveLength(0);
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

  it("accepts review gate verdicts without runId while the current lease is active", () => {
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

    expect(result.head.state).toBe("awaiting_pr_creation");
    expect(result.head.activeRunId).toBeNull();
    expect(result.head.activeRunSeq).toBe(1);
    expect(result.effects.map((effect) => effect.kind)).toEqual([
      "ensure_pr",
      "publish_status",
    ]);
  });

  it("gate_review_passed preserves the active lease before entering CI gate", () => {
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
    expect(result.head.activeRunId).toBe("run-review");
    expect(result.head.activeRunSeq).toBe(1);
  });

  it("gate_review_passed with mismatched runSeq is ignored", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const h = {
      ...head("gating_review"),
      activeGate: "review",
      activeRunId: "run-review",
      activeRunSeq: 4,
    };
    const result = reduce({
      head: h,
      event: {
        type: "gate_review_passed",
        runId: "run-review",
        runSeq: 5,
        prNumber: 42,
      },
      now,
    });

    expect(result.head.state).toBe("gating_review");
    expect(result.head.version).toBe(h.version);
    expect(result.head.activeRunSeq).toBe(4);
    expect(result.effects).toHaveLength(0);
  });

  it("gate_review_passed without linked PR transitions to awaiting_pr_creation", () => {
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

    expect(result.head.state).toBe("awaiting_pr_creation");
    expect(result.head.activeGate).toBeNull();
    expect(result.head.activeRunId).toBeNull();
    expect(result.head.activeRunSeq).toBe(1);
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

  it("awaiting_pr_creation re-enters CI gate on pr_linked", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("awaiting_pr_creation"),
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
        ...head("awaiting_pr_creation"),
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

  it("awaiting_pr_lifecycle ignores pr_linked", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("awaiting_pr_lifecycle"),
      },
      event: {
        type: "pr_linked",
        prNumber: 42,
      },
      now,
    });

    expect(result.head.state).toBe("awaiting_pr_lifecycle");
    expect(result.effects).toHaveLength(0);
  });

  it("awaiting_pr_creation retries to implementing when PR linkage fails", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("awaiting_pr_creation"),
        activeRunId: "run-review",
        activeRunSeq: 4,
        blockedReason: "Awaiting PR creation",
      },
      event: {
        type: "gate_review_failed",
        runId: "run-review",
        runSeq: 4,
        reason: "No code changes detected to open PR",
      },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.head.fixAttemptCount).toBe(1);
    expect(result.head.activeRunSeq).toBe(5);
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

  it("awaiting_pr_creation ignores gate_review_failed from a stale runSeq", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const h = {
      ...head("awaiting_pr_creation"),
      activeRunId: "run-review",
      activeRunSeq: 4,
      blockedReason: "Awaiting PR creation",
    };
    const result = reduce({
      head: h,
      event: {
        type: "gate_review_failed",
        runId: "run-review",
        runSeq: 3,
        reason: "Stale PR linkage failure",
      },
      now,
    });

    expect(result.head.state).toBe("awaiting_pr_creation");
    expect(result.head.version).toBe(h.version);
    expect(result.head.activeRunSeq).toBe(4);
    expect(result.effects).toHaveLength(0);
  });

  it("awaiting_pr_creation retries when no active lease and gate_review_failed has no lane", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const h = {
      ...head("awaiting_pr_creation"),
      activeRunId: null,
      activeRunSeq: null,
      blockedReason: "Awaiting PR creation",
    };
    const result = reduce({
      head: h,
      event: {
        type: "gate_review_failed",
        reason: "No code changes detected to open PR",
      },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.head.fixAttemptCount).toBe(1);
    expect(result.head.activeRunSeq).toBe(1);
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

  it("accepts correlated CI pass, clears the lease, and transitions to awaiting_pr_lifecycle", () => {
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

    expect(result.head.state).toBe("awaiting_pr_lifecycle");
    expect(result.head.activeGate).toBeNull();
    expect(result.head.activeRunId).toBeNull();
    expect(result.head.activeRunSeq).toBeNull();
    expect(result.head.lastTerminalRunSeq).toBe(1);
  });

  it("gate_ci_passed with mismatched runSeq is ignored even when headSha matches", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const h = {
      ...head("gating_ci"),
      activeGate: "ci",
      activeRunId: "run-ci",
      activeRunSeq: 11,
      headSha: "sha-current",
    };
    const result = reduce({
      head: h,
      event: {
        type: "gate_ci_passed",
        runId: "run-ci",
        runSeq: 12,
        headSha: "sha-current",
      },
      now,
    });

    expect(result.head.state).toBe("gating_ci");
    expect(result.head.version).toBe(h.version);
    expect(result.head.activeRunSeq).toBe(11);
    expect(result.effects).toHaveLength(0);
  });

  it("gating_ci run_failed uses infra retry lane and returns to implementing", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("gating_ci"),
        activeGate: "ci",
        infraRetryCount: 0,
      },
      event: {
        type: "run_failed",
        runId: "r-1",
        message: "sandbox crash",
        category: "infra_failure",
        lane: "infra",
      },
      now,
    });

    expect(result.head.state).toBe("implementing");
    expect(result.head.infraRetryCount).toBe(1);
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
    expect(result.head.activeRunSeq).toBe(1);
  });

  it("pr_closed preserves the active lease metadata while terminating", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const result = reduce({
      head: {
        ...head("gating_ci"),
        activeGate: "ci",
        activeRunId: "run-close",
        activeRunSeq: 9,
        headSha: "sha-current",
      },
      event: {
        type: "pr_closed",
        merged: false,
      },
      now,
    });

    expect(result.head.state).toBe("terminated");
    expect(result.head.activeRunId).toBeNull();
    expect(result.head.activeRunSeq).toBe(9);
    expect(result.head.lastTerminalRunSeq).toBeNull();
  });

  describe("implementing state fences stale runIds", () => {
    const NOW = new Date("2026-03-18T01:00:00.000Z");

    it("run_completed with different runId is ignored", () => {
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
      expect(result.head.state).toBe("implementing");
      expect(result.head.version).toBe(h.version);
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

    it("run_failed with different runId is ignored", () => {
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
      expect(result.head.version).toBe(h.version);
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

  it("dispatch_acked in planning is a no-op", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const h = { ...head("planning"), activeRunId: "run-bootstrap" };
    const result = reduce({
      head: h,
      event: { type: "dispatch_acked", runId: "run-bootstrap" },
      now,
    });
    expect(result.head.state).toBe("planning");
    expect(result.head.version).toBe(h.version);
  });

  it("dispatch_acked in gating_ci is a no-op", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const h = { ...head("gating_ci"), activeGate: "ci" };
    const result = reduce({
      head: h,
      event: { type: "dispatch_acked", runId: "run-1" },
      now,
    });
    expect(result.head.state).toBe("gating_ci");
    expect(result.head.version).toBe(h.version);
  });

  it("dispatch_acked in awaiting_pr_lifecycle is a no-op", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const h = head("awaiting_pr_lifecycle");
    const result = reduce({
      head: h,
      event: { type: "dispatch_acked", runId: "run-1" },
      now,
    });
    expect(result.head.state).toBe("awaiting_pr_lifecycle");
    expect(result.head.version).toBe(h.version);
  });

  it("dispatch_acked with matching runId in implementing sets activeRunId", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const h = { ...head("implementing"), activeRunId: "run-1" };
    const result = reduce({
      head: h,
      event: { type: "dispatch_acked", runId: "run-1" },
      now,
    });
    expect(result.head.state).toBe("implementing");
    expect(result.head.activeRunId).toBe("run-1");
  });

  it("dispatch_sent in gating_review is a legacy no-op", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const ackDeadlineAt = new Date("2026-03-18T01:01:30.000Z");
    const result = reduce({
      head: {
        ...head("gating_review"),
        activeGate: "review",
      },
      event: {
        type: "dispatch_sent",
        runId: "run-review",
        ackDeadlineAt,
      },
      now,
    });
    expect(result.head.state).toBe("gating_review");
    expect(result.head.activeRunId).toBeNull();
    expect(result.head.version).toBe(2);
    expect(result.effects).toHaveLength(0);
  });

  it("run_completed in gating_ci is a no-op", () => {
    const now = new Date("2026-03-18T01:00:00.000Z");
    const h = {
      ...head("gating_ci"),
      activeGate: "ci" as const,
      headSha: "sha-current",
    };
    const result = reduce({
      head: h,
      event: {
        type: "run_completed",
        runId: "run-stale",
        headSha: "sha-current",
      },
      now,
    });
    expect(result.head.state).toBe("gating_ci");
    expect(result.head.version).toBe(h.version);
    expect(result.effects).toHaveLength(0);
  });

  describe("terminal states absorb all events", () => {
    const NOW = new Date("2026-03-18T01:00:00.000Z");
    const events = [
      { type: "run_completed" as const, runId: "r-1", headSha: "sha-1" },
      { type: "dispatch_sent" as const, runId: "r-1", ackDeadlineAt: NOW },
      { type: "bootstrap" as const },
      { type: "plan_completed" as const },
    ];

    it("done state absorbs all events", () => {
      for (const event of events) {
        const result = reduce({ head: head("done"), event, now: NOW });
        expect(result.head.state).toBe("done");
        expect(result.effects).toHaveLength(0);
      }
    });

    it("stopped state absorbs all events", () => {
      for (const event of events) {
        const result = reduce({ head: head("stopped"), event, now: NOW });
        expect(result.head.state).toBe("stopped");
        expect(result.effects).toHaveLength(0);
      }
    });

    it("terminated state absorbs all events", () => {
      for (const event of events) {
        const result = reduce({ head: head("terminated"), event, now: NOW });
        expect(result.head.state).toBe("terminated");
        expect(result.effects).toHaveLength(0);
      }
    });

    it("stop_requested from done is a no-op", () => {
      const result = reduce({
        head: head("done"),
        event: { type: "stop_requested" },
        now: NOW,
      });
      expect(result.head.state).toBe("done");
      expect(result.effects).toHaveLength(0);
    });
  });

  describe("budget exhaustion", () => {
    const NOW = new Date("2026-03-18T01:00:00.000Z");

    it("fix budget exhaustion transitions to awaiting_manual_fix", () => {
      const h = {
        ...head("implementing"),
        fixAttemptCount: 6,
        maxFixAttempts: 6,
      };
      const result = reduce({
        head: h,
        event: {
          type: "run_failed",
          runId: "r-1",
          message: "test failure",
          category: null,
        },
        now: NOW,
      });
      expect(result.head.state).toBe("awaiting_manual_fix");
    });

    it("infra budget exhaustion transitions to awaiting_operator_action", () => {
      const h = {
        ...head("implementing"),
        infraRetryCount: 10,
        maxInfraRetries: 10,
      };
      const result = reduce({
        head: h,
        event: {
          type: "run_failed",
          runId: "r-1",
          message: "sandbox crash",
          category: "infra_failure",
          lane: "infra",
        },
        now: NOW,
      });
      expect(result.head.state).toBe("awaiting_operator_action");
    });
  });

  describe("global event handlers", () => {
    const NOW = new Date("2026-03-18T01:00:00.000Z");

    it("stop_requested from implementing transitions to stopped", () => {
      const result = reduce({
        head: head("implementing"),
        event: { type: "stop_requested" },
        now: NOW,
      });
      expect(result.head.state).toBe("stopped");
      expect(result.head.activeGate).toBeNull();
      expect(result.head.activeRunId).toBeNull();
    });

    it("pr_closed from gating_ci transitions to terminated", () => {
      const result = reduce({
        head: {
          ...head("gating_ci"),
          activeGate: "ci",
          headSha: "sha-1",
        },
        event: { type: "pr_closed", merged: false },
        now: NOW,
      });
      expect(result.head.state).toBe("terminated");
      expect(result.head.activeGate).toBeNull();
      expect(result.head.activeRunId).toBeNull();
    });
  });

  describe("awaiting_pr_creation noop verification", () => {
    const NOW = new Date("2026-03-18T01:00:00.000Z");

    it("awaiting_pr_creation ignores run_completed (stale event)", () => {
      const h = {
        ...head("awaiting_pr_creation"),
        blockedReason: "Awaiting PR creation",
        headSha: "sha-1",
      };
      const result = reduce({
        head: h,
        event: {
          type: "run_completed",
          runId: "run-stale",
          headSha: "sha-1",
        },
        now: NOW,
      });
      expect(result.head.state).toBe("awaiting_pr_creation");
      expect(result.head.version).toBe(h.version);
      expect(result.effects).toHaveLength(0);
    });
  });

  describe("awaiting_pr_creation + pr_linked happy path", () => {
    it("awaiting_pr_creation + pr_linked transitions to gating_ci", () => {
      const now = new Date("2026-03-18T01:00:00.000Z");
      const h = {
        ...head("awaiting_pr_creation"),
        blockedReason: "Awaiting PR creation",
        headSha: "sha-abc",
      };
      const result = reduce({
        head: h,
        event: { type: "pr_linked", prNumber: 55 },
        now,
      });

      expect(result.head.state).toBe("gating_ci");
      expect(result.head.activeGate).toBe("ci");
      expect(result.head.activeRunId).toBeNull();
      expect(result.head.blockedReason).toBeNull();
      expect(result.head.version).toBeGreaterThan(h.version);
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
  });

  describe("awaiting_manual_fix and awaiting_operator_action", () => {
    const NOW = new Date("2026-03-18T01:00:00.000Z");

    it("awaiting_manual_fix + resume_requested transitions to implementing", () => {
      const h = {
        ...head("awaiting_manual_fix"),
        blockedReason: "Fix attempt budget exhausted",
        fixAttemptCount: 6,
      };
      const result = reduce({
        head: h,
        event: { type: "resume_requested" },
        now: NOW,
      });

      expect(result.head.state).toBe("implementing");
      expect(result.head.blockedReason).toBeNull();
      expect(result.head.activeRunId).toBeNull();
      expect(result.effects).toHaveLength(2);
      expect(result.effects[0]?.kind).toBe("dispatch_implementing");
      expect(result.effects[1]?.kind).toBe("publish_status");
    });

    it("awaiting_operator_action + resume_requested transitions to implementing", () => {
      const h = {
        ...head("awaiting_operator_action"),
        blockedReason: "Infrastructure retry budget exhausted",
        infraRetryCount: 10,
      };
      const result = reduce({
        head: h,
        event: { type: "resume_requested" },
        now: NOW,
      });

      expect(result.head.state).toBe("implementing");
      expect(result.head.blockedReason).toBeNull();
      expect(result.head.activeRunId).toBeNull();
      expect(result.effects).toHaveLength(2);
      expect(result.effects[0]?.kind).toBe("dispatch_implementing");
      expect(result.effects[1]?.kind).toBe("publish_status");
    });

    it("awaiting_manual_fix ignores dispatch_acked", () => {
      const h = {
        ...head("awaiting_manual_fix"),
        blockedReason: "Fix attempt budget exhausted",
      };
      const result = reduce({
        head: h,
        event: { type: "dispatch_acked", runId: "run-stale" },
        now: NOW,
      });

      expect(result.head.state).toBe("awaiting_manual_fix");
      expect(result.head.version).toBe(h.version);
      expect(result.effects).toHaveLength(0);
    });
  });

  describe("shared transition contract parity", () => {
    for (const state of ALL_STATES) {
      describe(state, () => {
        const expectations = EXPECTED_TRANSITIONS[state]!;
        for (const event of ALL_CANONICAL_EVENTS) {
          const cell = expectations[event.type]!;
          it(`contract ${event.type} -> ${cell.target}`, () => {
            const contractHead = makeContractHead(state);
            const result = reduce({
              head: contractHead,
              event,
              now: CONTRACT_NOW,
            });

            if (cell.target === "noop") {
              expect(result.head.state).toBe(state);
              expect(result.head.version).toBe(contractHead.version);
            } else if (cell.target === "stay") {
              expect(result.head.state).toBe(state);
              expect(result.head.version).toBeGreaterThan(contractHead.version);
            } else {
              expect(result.head.state).toBe(cell.target as WorkflowState);
            }
            expect(result.effects.map((effect) => effect.kind)).toEqual(
              cell.effects ?? [],
            );
          });
        }
      });
    }
  });

  describe("shared branch contract parity", () => {
    for (const testCase of BRANCH_CASES) {
      it(`contract ${testCase.name}`, () => {
        const result = reduce({
          head: testCase.head,
          event: testCase.event,
          now: CONTRACT_NOW,
        });
        expect(result.head.state).toBe(testCase.expectedState);
        if (testCase.expectedVersionDelta === 0) {
          expect(result.head.version).toBe(testCase.head.version);
        } else {
          expect(result.head.version).toBeGreaterThan(testCase.head.version);
        }
        expect(result.effects.map((effect) => effect.kind)).toEqual(
          testCase.expectedEffects,
        );
      });
    }
  });
});
