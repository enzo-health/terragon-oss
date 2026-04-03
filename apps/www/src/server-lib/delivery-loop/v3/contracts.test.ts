import type {
  DeliveryEffectLedgerV3Insert,
  DeliveryLoopJournalV3Insert,
  DeliveryOutboxV3Insert,
  DeliveryTimerLedgerV3Insert,
} from "@terragon/shared/db/types";
import { describe, expect, it } from "vitest";
import {
  buildEffectLedgerContract,
  parseEffectPayload,
  parseLoopEvent,
  serializeEffectPayload,
  serializeLoopEvent,
} from "./contracts";

type RequiresIdempotencyKey<T extends { idempotencyKey: string }> = true;

const signalInsertRequiresIdempotency: RequiresIdempotencyKey<DeliveryLoopJournalV3Insert> =
  true;
const effectInsertRequiresIdempotency: RequiresIdempotencyKey<DeliveryEffectLedgerV3Insert> =
  true;
const timerInsertRequiresIdempotency: RequiresIdempotencyKey<DeliveryTimerLedgerV3Insert> =
  true;
const outboxInsertRequiresIdempotency: RequiresIdempotencyKey<DeliveryOutboxV3Insert> =
  true;

describe("v3 contracts", () => {
  it("round-trips a dispatch_sent event payload", () => {
    const ackDeadlineAt = new Date("2026-03-18T12:00:45.000Z");
    const serialized = serializeLoopEvent({
      type: "dispatch_sent",
      runId: "run-123",
      ackDeadlineAt,
    });
    const parsed = parseLoopEvent(serialized);

    expect(parsed).toEqual({
      type: "dispatch_sent",
      runId: "run-123",
      ackDeadlineAt,
    });
  });

  it("round-trips a dispatch_queued event payload", () => {
    const ackDeadlineAt = new Date("2026-03-18T12:00:45.000Z");
    const serialized = serializeLoopEvent({
      type: "dispatch_queued",
      runId: "run-queued-123",
      ackDeadlineAt,
    });
    const parsed = parseLoopEvent(serialized);

    expect(parsed).toEqual({
      type: "dispatch_queued",
      runId: "run-queued-123",
      ackDeadlineAt,
    });
  });

  it("round-trips a dispatch_claimed event payload", () => {
    const serialized = serializeLoopEvent({
      type: "dispatch_claimed",
      runId: "run-claimed-123",
    });
    const parsed = parseLoopEvent(serialized);

    expect(parsed).toEqual({
      type: "dispatch_claimed",
      runId: "run-claimed-123",
    });
  });

  it("round-trips a dispatch_accepted event payload", () => {
    const serialized = serializeLoopEvent({
      type: "dispatch_accepted",
      runId: "run-accepted-123",
    });
    const parsed = parseLoopEvent(serialized);

    expect(parsed).toEqual({
      type: "dispatch_accepted",
      runId: "run-accepted-123",
    });
  });

  it("round-trips planning events with runSeq present", () => {
    const planningCompleted = parseLoopEvent(
      serializeLoopEvent({
        type: "planning_run_completed",
        runId: "run-planning-1",
        runSeq: 4,
      }),
    );
    expect(planningCompleted).toEqual({
      type: "planning_run_completed",
      runId: "run-planning-1",
      runSeq: 4,
    });

    const planFailed = parseLoopEvent(
      serializeLoopEvent({
        type: "plan_failed",
        reason: "planning failed",
        runId: "run-planning-2",
        runSeq: 5,
      }),
    );
    expect(planFailed).toEqual({
      type: "plan_failed",
      reason: "planning failed",
      runId: "run-planning-2",
      runSeq: 5,
    });
  });

  it("rejects malformed runSeq values for planning events", () => {
    expect(
      parseLoopEvent({
        type: "planning_run_completed",
        runId: "run-planning-1",
        runSeq: "bad",
      }),
    ).toBeNull();

    expect(
      parseLoopEvent({
        type: "plan_failed",
        reason: "planning failed",
        runId: "run-planning-2",
        runSeq: 1.5,
      }),
    ).toBeNull();
  });

  it("rejects invalid loop event payloads", () => {
    const parsed = parseLoopEvent({
      type: "dispatch_sent",
      runId: "run-123",
      ackDeadlineAt: 123,
    });
    expect(parsed).toBeNull();
  });

  it("accepts omitted runSeq for legacy terminal and gate events", () => {
    expect(
      parseLoopEvent({
        type: "run_completed",
        runId: "run-1",
        headSha: "sha-1",
      }),
    ).toEqual({
      type: "run_completed",
      runId: "run-1",
      runSeq: null,
      headSha: "sha-1",
    });

    expect(
      parseLoopEvent({
        type: "run_failed",
        runId: "run-2",
        message: "boom",
        category: null,
      }),
    ).toEqual({
      type: "run_failed",
      runId: "run-2",
      runSeq: null,
      message: "boom",
      category: null,
      lane: undefined,
    });

    expect(
      parseLoopEvent({
        type: "gate_review_passed",
        runId: "run-review-1",
        headSha: "sha-review-1",
        prNumber: 123,
      }),
    ).toEqual({
      type: "gate_review_passed",
      runId: "run-review-1",
      runSeq: null,
      headSha: "sha-review-1",
      prNumber: 123,
    });

    expect(
      parseLoopEvent({
        type: "gate_review_failed",
        runId: "run-review-2",
        reason: "review failed",
      }),
    ).toEqual({
      type: "gate_review_failed",
      runId: "run-review-2",
      runSeq: null,
      reason: "review failed",
    });

    expect(
      parseLoopEvent({
        type: "gate_ci_passed",
        runId: "run-ci-1",
        headSha: "sha-ci-1",
      }),
    ).toEqual({
      type: "gate_ci_passed",
      runId: "run-ci-1",
      runSeq: null,
      headSha: "sha-ci-1",
    });

    expect(
      parseLoopEvent({
        type: "gate_ci_failed",
        runId: "run-ci-2",
        headSha: "sha-ci-2",
        reason: "CI checks failed",
      }),
    ).toEqual({
      type: "gate_ci_failed",
      runId: "run-ci-2",
      runSeq: null,
      headSha: "sha-ci-2",
      reason: "CI checks failed",
    });
  });

  it("round-trips correlated CI gate events", () => {
    const serializedPassed = serializeLoopEvent({
      type: "gate_ci_passed",
      runId: "run-ci-1",
      runSeq: 7,
      headSha: "sha-ci-1",
    });
    const parsedPassed = parseLoopEvent(serializedPassed);
    expect(parsedPassed).toEqual({
      type: "gate_ci_passed",
      runId: "run-ci-1",
      runSeq: 7,
      headSha: "sha-ci-1",
    });

    const serializedFailed = serializeLoopEvent({
      type: "gate_ci_failed",
      runId: "run-ci-2",
      runSeq: 8,
      headSha: "sha-ci-2",
      reason: "CI checks failed",
    });
    const parsedFailed = parseLoopEvent(serializedFailed);
    expect(parsedFailed).toEqual({
      type: "gate_ci_failed",
      runId: "run-ci-2",
      runSeq: 8,
      headSha: "sha-ci-2",
      reason: "CI checks failed",
    });
  });

  it("round-trips gate_review_passed with optional PR context", () => {
    const serialized = serializeLoopEvent({
      type: "gate_review_passed",
      runId: "run-review-1",
      runSeq: 9,
      headSha: "sha-review-1",
      prNumber: 123,
    });
    const parsed = parseLoopEvent(serialized);

    expect(parsed).toEqual({
      type: "gate_review_passed",
      runId: "run-review-1",
      runSeq: 9,
      headSha: "sha-review-1",
      prNumber: 123,
    });
  });

  it("round-trips run terminal events with optional runSeq", () => {
    const completed = parseLoopEvent(
      serializeLoopEvent({
        type: "run_completed",
        runId: "run-1",
        runSeq: 11,
        headSha: "sha-1",
      }),
    );
    expect(completed).toEqual({
      type: "run_completed",
      runId: "run-1",
      runSeq: 11,
      headSha: "sha-1",
    });

    const failed = parseLoopEvent(
      serializeLoopEvent({
        type: "run_failed",
        runId: "run-2",
        runSeq: 12,
        message: "boom",
        category: null,
      }),
    );
    expect(failed).toEqual({
      type: "run_failed",
      runId: "run-2",
      runSeq: 12,
      message: "boom",
      category: null,
      lane: undefined,
    });
  });

  it("round-trips pr_linked with optional PR context", () => {
    const serialized = serializeLoopEvent({
      type: "pr_linked",
      prNumber: 456,
    });
    const parsed = parseLoopEvent(serialized);

    expect(parsed).toEqual({
      type: "pr_linked",
      prNumber: 456,
    });
  });

  it("rejects malformed CI gate correlation payloads", () => {
    expect(
      parseLoopEvent({
        type: "gate_ci_passed",
        headSha: 123,
      }),
    ).toBeNull();

    expect(
      parseLoopEvent({
        type: "gate_ci_failed",
        runId: 123,
      }),
    ).toBeNull();
    expect(
      parseLoopEvent({
        type: "gate_review_passed",
        headSha: 123,
      }),
    ).toBeNull();
    expect(
      parseLoopEvent({
        type: "gate_review_passed",
        prNumber: 1.5,
      }),
    ).toBeNull();
    expect(
      parseLoopEvent({
        type: "pr_linked",
        prNumber: 1.5,
      }),
    ).toBeNull();
  });

  it("round-trips lease expiry effect payload contracts", () => {
    const serialized = serializeEffectPayload({
      kind: "run_lease_expiry_check",
      runId: "run-ack",
      workflowVersion: 7,
    });
    const parsed = parseEffectPayload(serialized);

    expect(parsed).toEqual({
      kind: "run_lease_expiry_check",
      runId: "run-ack",
      workflowVersion: 7,
    });
  });

  it("parses legacy ack timeout payload contracts during migration", () => {
    const parsed = parseEffectPayload({
      kind: "ack_timeout_check",
      runId: "run-ack",
      workflowVersion: 7,
    });

    expect(parsed).toEqual({
      kind: "ack_timeout_check",
      runId: "run-ack",
      workflowVersion: 7,
    });
  });

  it("round-trips dispatch_implementing with fallback executionClass", () => {
    const serialized = serializeEffectPayload({
      kind: "dispatch_implementing",
      executionClass: "implementation_runtime_fallback",
    });
    const parsed = parseEffectPayload(serialized);

    expect(parsed).toEqual({
      kind: "dispatch_implementing",
      executionClass: "implementation_runtime_fallback",
    });
  });

  it("round-trips ensure_pr effect payload", () => {
    const serialized = serializeEffectPayload({
      kind: "ensure_pr",
    });
    const parsed = parseEffectPayload(serialized);

    expect(parsed).toEqual({
      kind: "ensure_pr",
    });
  });

  it("builds effect ledger contracts with canonical idempotency", () => {
    const contract = buildEffectLedgerContract({
      workflowId: "wf-1",
      workflowVersion: 11,
      effect: {
        kind: "dispatch_implementing",
        effectKey: "wf-1:11:dispatch_implementing",
        dueAt: new Date("2026-03-18T12:10:00.000Z"),
        payload: {
          kind: "dispatch_implementing",
          executionClass: "implementation_runtime_fallback",
        },
      },
    });

    expect(contract.idempotencyKey).toBe(contract.effectKey);
    expect(contract.maxAttempts).toBe(5);
  });

  it("keeps idempotencyKey required on all v3 insert contracts", () => {
    expect(signalInsertRequiresIdempotency).toBe(true);
    expect(effectInsertRequiresIdempotency).toBe(true);
    expect(timerInsertRequiresIdempotency).toBe(true);
    expect(outboxInsertRequiresIdempotency).toBe(true);
  });
});
