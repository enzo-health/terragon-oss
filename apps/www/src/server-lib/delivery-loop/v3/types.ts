import type {
  DeliveryEffectKindV3,
  DeliveryLoopState,
} from "@terragon/shared/db/types";
import {
  type FailureLane,
  classifyFailureLane as classifyFailureLaneShared,
} from "@terragon/shared/delivery-loop/domain/failure-signature";

export type WorkflowState =
  | "planning"
  | "implementing"
  | "gating_review"
  | "gating_ci"
  | "awaiting_pr"
  | "awaiting_manual_fix"
  | "awaiting_operator_action"
  | "done"
  | "stopped"
  | "terminated";

export type LoopEvent =
  | { type: "bootstrap" }
  | { type: "planning_run_completed" }
  | { type: "plan_completed" }
  | { type: "plan_failed"; reason: string }
  | { type: "dispatch_sent"; runId: string; ackDeadlineAt: Date }
  | { type: "dispatch_acked"; runId: string }
  | { type: "dispatch_ack_timeout"; runId: string }
  | { type: "run_completed"; runId: string; headSha?: string | null }
  | {
      type: "run_failed";
      runId: string;
      message: string;
      category: string | null;
      lane?: FailureLane;
    }
  | {
      type: "gate_review_passed";
      runId?: string | null;
      prNumber?: number | null;
    }
  | { type: "pr_linked"; prNumber?: number | null }
  | {
      type: "gate_review_failed";
      runId?: string | null;
      reason?: string | null;
    }
  | {
      type: "gate_ci_passed";
      runId?: string | null;
      headSha?: string | null;
    }
  | {
      type: "gate_ci_failed";
      runId?: string | null;
      headSha?: string | null;
      reason?: string | null;
    }
  | { type: "resume_requested" }
  | { type: "stop_requested" }
  | { type: "pr_closed"; merged: boolean };

export type EffectKind = DeliveryEffectKindV3;

export type EffectPayload =
  | {
      kind: "dispatch_implementing";
      executionClass:
        | "implementation_runtime"
        | "implementation_runtime_fallback";
    }
  | { kind: "dispatch_gate_review"; gate: "review" }
  | {
      kind: "ack_timeout_check";
      runId: string;
      workflowVersion: number;
    }
  | { kind: "ensure_pr" }
  | { kind: "create_plan_artifact" }
  | { kind: "publish_status" }
  | { kind: "gate_staleness_check"; workflowVersion: number };

export type EffectSpec = {
  kind: EffectKind;
  effectKey: string;
  dueAt: Date;
  maxAttempts?: number;
  payload: EffectPayload;
};

/**
 * Typed result returned by state-blocking effect handlers.
 * The framework maps these to LoopEvent via effectResultToEvent().
 * Handlers return data; they never call appendEventAndAdvance directly.
 */
export type EffectResult =
  // create_plan_artifact results
  | {
      kind: "create_plan_artifact";
      outcome: "created";
      approvalPolicy: "auto" | "human";
    }
  | { kind: "create_plan_artifact"; outcome: "failed"; reason: string }
  // dispatch_gate_review results
  | {
      kind: "dispatch_gate_review";
      outcome: "dispatched";
      runId: string;
      ackDeadlineAt: Date;
    }
  | { kind: "dispatch_gate_review"; outcome: "failed"; reason: string }
  // ensure_pr results
  | { kind: "ensure_pr"; outcome: "linked"; prNumber: number }
  | { kind: "ensure_pr"; outcome: "no_diff"; reason: string }
  | { kind: "ensure_pr"; outcome: "failed"; reason: string }
  // dispatch_implementing results
  | {
      kind: "dispatch_implementing";
      outcome: "dispatched";
      runId: string;
      ackDeadlineAt: Date;
    }
  | { kind: "dispatch_implementing"; outcome: "failed"; reason: string }
  // ack_timeout_check results
  | { kind: "ack_timeout_check"; outcome: "fired"; runId: string }
  | { kind: "ack_timeout_check"; outcome: "stale" }
  // gate_staleness_check results
  | { kind: "gate_staleness_check"; outcome: "ci_passed"; headSha: string }
  | {
      kind: "gate_staleness_check";
      outcome: "ci_failed";
      headSha: string;
      reason: string;
    }
  | { kind: "gate_staleness_check"; outcome: "pending" }
  | { kind: "gate_staleness_check"; outcome: "stale" };

export type WorkflowHead = {
  workflowId: string;
  threadId: string;
  generation: number;
  version: number;
  state: WorkflowState;
  activeGate: string | null;
  headSha: string | null;
  activeRunId: string | null;
  fixAttemptCount: number;
  infraRetryCount: number;
  maxFixAttempts: number;
  maxInfraRetries: number;
  blockedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date | null;
};

export function stateToDeliveryLoopState(
  state: WorkflowState,
): DeliveryLoopState {
  switch (state) {
    case "planning":
      return "planning";
    case "implementing":
      return "implementing";
    case "gating_review":
      return "review_gate";
    case "gating_ci":
      return "ci_gate";
    case "awaiting_pr":
      return "awaiting_pr_link";
    case "awaiting_manual_fix":
    case "awaiting_operator_action":
      return "blocked";
    case "done":
      return "done";
    case "stopped":
      return "stopped";
    case "terminated":
      return "terminated_pr_closed";
  }
}

export const AWAITING_PR_CREATION_REASON = "Awaiting PR creation";

export function isTerminalState(state: WorkflowState): boolean {
  return state === "done" || state === "stopped" || state === "terminated";
}

export function classifyFailureLane(params: {
  category: string | null;
  message: string | null;
}): FailureLane {
  return classifyFailureLaneShared({
    category: params.category,
    message: params.message,
  });
}
