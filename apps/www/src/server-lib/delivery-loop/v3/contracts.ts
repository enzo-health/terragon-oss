import type {
  DeliveryEffectKindV3,
  DeliveryOutboxTopicV3,
  DeliverySignalSourceV3,
  DeliveryTimerKindV3,
} from "@terragon/shared/db/types";
import type { EffectPayloadV3, EffectSpecV3, LoopEventV3 } from "./types";

export type SignalJournalWriteContractV3 = {
  workflowId: string;
  source: DeliverySignalSourceV3;
  idempotencyKey: string;
  eventType: LoopEventV3["type"];
  payload: LoopEventV3;
  occurredAt: Date;
};

export type EffectLedgerWriteContractV3 = {
  workflowId: string;
  workflowVersion: number;
  effectKind: DeliveryEffectKindV3;
  effectKey: string;
  idempotencyKey: string;
  dueAt: Date;
  maxAttempts: number;
  payload: EffectPayloadV3;
};

export type TimerPayloadV3 = {
  kind: "dispatch_ack_timeout";
  runId: string;
  workflowVersion: number;
};

export type TimerLedgerWriteContractV3 = {
  workflowId: string;
  timerKind: DeliveryTimerKindV3;
  timerKey: string;
  idempotencyKey: string;
  sourceSignalId: string | null;
  dueAt: Date;
  maxAttempts: number;
  payload: TimerPayloadV3;
};

export type OutboxPayloadV3 =
  | {
      kind: "signal";
      journalId: string;
      workflowId: string;
      eventType: LoopEventV3["type"];
      source: DeliverySignalSourceV3;
    }
  | {
      kind: "effect";
      effectId: string;
      workflowId: string;
      effectKind: DeliveryEffectKindV3;
    }
  | {
      kind: "timer";
      timerId: string;
      workflowId: string;
      timerKind: DeliveryTimerKindV3;
    };

export type OutboxWriteContractV3 = {
  workflowId: string;
  topic: DeliveryOutboxTopicV3;
  dedupeKey: string;
  idempotencyKey: string;
  availableAt: Date;
  maxAttempts: number;
  payload: OutboxPayloadV3;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function serializeLoopEventV3(
  event: LoopEventV3,
): Record<string, unknown> {
  switch (event.type) {
    case "bootstrap":
    case "plan_completed":
    case "gate_ci_passed":
    case "resume_requested":
    case "stop_requested":
      return { type: event.type };
    case "dispatch_sent":
      return {
        type: event.type,
        runId: event.runId,
        ackDeadlineAt: event.ackDeadlineAt.toISOString(),
      };
    case "dispatch_acked":
    case "dispatch_ack_timeout":
      return {
        type: event.type,
        runId: event.runId,
      };
    case "run_completed":
      return {
        type: event.type,
        runId: event.runId,
        headSha: event.headSha ?? null,
      };
    case "run_failed":
      return {
        type: event.type,
        runId: event.runId,
        message: event.message,
        category: event.category,
        lane: event.lane ?? null,
      };
    case "gate_review_passed":
      return {
        type: event.type,
        runId: event.runId ?? null,
      };
    case "gate_review_failed":
      return {
        type: event.type,
        runId: event.runId ?? null,
        reason: event.reason ?? null,
      };
    case "gate_ci_failed":
      return {
        type: event.type,
        reason: event.reason ?? null,
      };
    case "pr_closed":
      return {
        type: event.type,
        merged: event.merged,
      };
  }
}

export function parseLoopEventV3(payload: unknown): LoopEventV3 | null {
  if (!isRecord(payload) || typeof payload.type !== "string") {
    return null;
  }

  switch (payload.type) {
    case "bootstrap":
    case "plan_completed":
    case "gate_ci_passed":
    case "resume_requested":
    case "stop_requested":
      return { type: payload.type };
    case "dispatch_sent": {
      if (typeof payload.runId !== "string") {
        return null;
      }
      const ackDeadlineAt = toDate(payload.ackDeadlineAt);
      if (!ackDeadlineAt) {
        return null;
      }
      return {
        type: "dispatch_sent",
        runId: payload.runId,
        ackDeadlineAt,
      };
    }
    case "dispatch_acked":
    case "dispatch_ack_timeout":
      if (typeof payload.runId !== "string") {
        return null;
      }
      return {
        type: payload.type,
        runId: payload.runId,
      };
    case "run_completed":
      if (typeof payload.runId !== "string") {
        return null;
      }
      if (
        payload.headSha !== undefined &&
        payload.headSha !== null &&
        typeof payload.headSha !== "string"
      ) {
        return null;
      }
      return {
        type: "run_completed",
        runId: payload.runId,
        headSha: (payload.headSha as string | null | undefined) ?? null,
      };
    case "run_failed":
      if (
        typeof payload.runId !== "string" ||
        typeof payload.message !== "string"
      ) {
        return null;
      }
      if (payload.category !== null && typeof payload.category !== "string") {
        return null;
      }
      if (
        payload.lane !== undefined &&
        payload.lane !== null &&
        payload.lane !== "agent" &&
        payload.lane !== "infra"
      ) {
        return null;
      }
      return {
        type: "run_failed",
        runId: payload.runId,
        message: payload.message,
        category: (payload.category as string | null | undefined) ?? null,
        lane:
          payload.lane === "agent" || payload.lane === "infra"
            ? payload.lane
            : undefined,
      };
    case "gate_review_passed":
      if (
        payload.runId !== undefined &&
        payload.runId !== null &&
        typeof payload.runId !== "string"
      ) {
        return null;
      }
      return {
        type: "gate_review_passed",
        runId: (payload.runId as string | null | undefined) ?? null,
      };
    case "gate_review_failed":
      if (
        payload.runId !== undefined &&
        payload.runId !== null &&
        typeof payload.runId !== "string"
      ) {
        return null;
      }
      if (
        payload.reason !== undefined &&
        payload.reason !== null &&
        typeof payload.reason !== "string"
      ) {
        return null;
      }
      return {
        type: "gate_review_failed",
        runId: (payload.runId as string | null | undefined) ?? null,
        reason: (payload.reason as string | null | undefined) ?? null,
      };
    case "gate_ci_failed":
      if (
        payload.reason !== undefined &&
        payload.reason !== null &&
        typeof payload.reason !== "string"
      ) {
        return null;
      }
      return {
        type: "gate_ci_failed",
        reason: (payload.reason as string | null | undefined) ?? null,
      };
    case "pr_closed":
      if (typeof payload.merged !== "boolean") {
        return null;
      }
      return {
        type: "pr_closed",
        merged: payload.merged,
      };
    default:
      return null;
  }
}

export function serializeEffectPayloadV3(
  payload: EffectPayloadV3,
): Record<string, unknown> {
  switch (payload.kind) {
    case "dispatch_implementing":
      return { kind: payload.kind };
    case "dispatch_gate_review":
      return { kind: payload.kind, gate: payload.gate };
    case "ack_timeout_check":
      return {
        kind: payload.kind,
        runId: payload.runId,
        workflowVersion: payload.workflowVersion,
      };
  }
}

export function parseEffectPayloadV3(payload: unknown): EffectPayloadV3 | null {
  if (!isRecord(payload) || typeof payload.kind !== "string") {
    return null;
  }
  if (payload.kind === "dispatch_implementing") {
    return { kind: "dispatch_implementing" };
  }
  if (payload.kind === "dispatch_gate_review" && payload.gate === "review") {
    return { kind: "dispatch_gate_review", gate: "review" };
  }
  if (
    payload.kind === "ack_timeout_check" &&
    typeof payload.runId === "string" &&
    typeof payload.workflowVersion === "number"
  ) {
    return {
      kind: "ack_timeout_check",
      runId: payload.runId,
      workflowVersion: payload.workflowVersion,
    };
  }
  return null;
}

export function serializeTimerPayloadV3(
  payload: TimerPayloadV3,
): Record<string, unknown> {
  return {
    kind: payload.kind,
    runId: payload.runId,
    workflowVersion: payload.workflowVersion,
  };
}

export function parseTimerPayloadV3(payload: unknown): TimerPayloadV3 | null {
  if (
    isRecord(payload) &&
    payload.kind === "dispatch_ack_timeout" &&
    typeof payload.runId === "string" &&
    typeof payload.workflowVersion === "number"
  ) {
    return {
      kind: "dispatch_ack_timeout",
      runId: payload.runId,
      workflowVersion: payload.workflowVersion,
    };
  }
  return null;
}

export function serializeOutboxPayloadV3(
  payload: OutboxPayloadV3,
): Record<string, unknown> {
  switch (payload.kind) {
    case "signal":
      return {
        kind: payload.kind,
        journalId: payload.journalId,
        workflowId: payload.workflowId,
        eventType: payload.eventType,
        source: payload.source,
      };
    case "effect":
      return {
        kind: payload.kind,
        effectId: payload.effectId,
        workflowId: payload.workflowId,
        effectKind: payload.effectKind,
      };
    case "timer":
      return {
        kind: payload.kind,
        timerId: payload.timerId,
        workflowId: payload.workflowId,
        timerKind: payload.timerKind,
      };
  }
}

export function buildSignalJournalContractV3(params: {
  workflowId: string;
  source: DeliverySignalSourceV3;
  idempotencyKey: string;
  event: LoopEventV3;
  occurredAt: Date;
}): SignalJournalWriteContractV3 {
  return {
    workflowId: params.workflowId,
    source: params.source,
    idempotencyKey: params.idempotencyKey,
    eventType: params.event.type,
    payload: params.event,
    occurredAt: params.occurredAt,
  };
}

export function buildEffectLedgerContractV3(params: {
  workflowId: string;
  workflowVersion: number;
  effect: EffectSpecV3;
}): EffectLedgerWriteContractV3 {
  return {
    workflowId: params.workflowId,
    workflowVersion: params.workflowVersion,
    effectKind: params.effect.kind,
    effectKey: params.effect.effectKey,
    idempotencyKey: params.effect.effectKey,
    dueAt: params.effect.dueAt,
    maxAttempts: params.effect.maxAttempts ?? 5,
    payload: params.effect.payload,
  };
}
