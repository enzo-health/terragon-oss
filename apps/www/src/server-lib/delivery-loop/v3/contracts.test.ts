import type {
  DeliveryEffectLedgerV3Insert,
  DeliveryLoopJournalV3Insert,
  DeliveryOutboxV3Insert,
  DeliveryTimerLedgerV3Insert,
} from "@terragon/shared/db/types";
import { describe, expect, it } from "vitest";
import {
  buildEffectLedgerContractV3,
  parseEffectPayloadV3,
  parseLoopEventV3,
  serializeEffectPayloadV3,
  serializeLoopEventV3,
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
    const serialized = serializeLoopEventV3({
      type: "dispatch_sent",
      runId: "run-123",
      ackDeadlineAt,
    });
    const parsed = parseLoopEventV3(serialized);

    expect(parsed).toEqual({
      type: "dispatch_sent",
      runId: "run-123",
      ackDeadlineAt,
    });
  });

  it("rejects invalid loop event payloads", () => {
    const parsed = parseLoopEventV3({
      type: "dispatch_sent",
      runId: "run-123",
      ackDeadlineAt: 123,
    });
    expect(parsed).toBeNull();
  });

  it("round-trips correlated CI gate events", () => {
    const serializedPassed = serializeLoopEventV3({
      type: "gate_ci_passed",
      runId: "run-ci-1",
      headSha: "sha-ci-1",
    });
    const parsedPassed = parseLoopEventV3(serializedPassed);
    expect(parsedPassed).toEqual({
      type: "gate_ci_passed",
      runId: "run-ci-1",
      headSha: "sha-ci-1",
    });

    const serializedFailed = serializeLoopEventV3({
      type: "gate_ci_failed",
      runId: "run-ci-2",
      headSha: "sha-ci-2",
      reason: "CI checks failed",
    });
    const parsedFailed = parseLoopEventV3(serializedFailed);
    expect(parsedFailed).toEqual({
      type: "gate_ci_failed",
      runId: "run-ci-2",
      headSha: "sha-ci-2",
      reason: "CI checks failed",
    });
  });

  it("rejects malformed CI gate correlation payloads", () => {
    expect(
      parseLoopEventV3({
        type: "gate_ci_passed",
        headSha: 123,
      }),
    ).toBeNull();

    expect(
      parseLoopEventV3({
        type: "gate_ci_failed",
        runId: 123,
      }),
    ).toBeNull();
  });

  it("round-trips effect payload contracts", () => {
    const serialized = serializeEffectPayloadV3({
      kind: "ack_timeout_check",
      runId: "run-ack",
      workflowVersion: 7,
    });
    const parsed = parseEffectPayloadV3(serialized);

    expect(parsed).toEqual({
      kind: "ack_timeout_check",
      runId: "run-ack",
      workflowVersion: 7,
    });
  });

  it("round-trips dispatch_implementing with fallback executionClass", () => {
    const serialized = serializeEffectPayloadV3({
      kind: "dispatch_implementing",
      executionClass: "implementation_runtime_fallback",
    });
    const parsed = parseEffectPayloadV3(serialized);

    expect(parsed).toEqual({
      kind: "dispatch_implementing",
      executionClass: "implementation_runtime_fallback",
    });
  });

  it("builds effect ledger contracts with canonical idempotency", () => {
    const contract = buildEffectLedgerContractV3({
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
