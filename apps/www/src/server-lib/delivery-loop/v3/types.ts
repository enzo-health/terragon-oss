import type {
  DeliveryEffectKindV3,
  DeliveryLoopState,
} from "@terragon/shared/db/types";
import {
  type FailureLane,
  classifyFailureLane as classifyFailureLaneShared,
} from "@terragon/shared/delivery-loop/domain/failure-signature";

export type WorkflowStateV3 =
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

export type LoopEventV3 =
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

export type EffectKindV3 = DeliveryEffectKindV3;

export type EffectPayloadV3 =
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
  | { kind: "publish_status" };

export type EffectSpecV3 = {
  kind: EffectKindV3;
  effectKey: string;
  dueAt: Date;
  maxAttempts?: number;
  payload: EffectPayloadV3;
};

/**
 * Typed result returned by state-blocking effect handlers.
 * The framework maps these to LoopEventV3 via effectResultToEvent().
 * Handlers return data; they never call appendEventAndAdvanceV3 directly.
 */
export type EffectResultV3 =
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
  | { kind: "ack_timeout_check"; outcome: "stale" };

export type WorkflowHeadV3 = {
  workflowId: string;
  threadId: string;
  generation: number;
  version: number;
  state: WorkflowStateV3;
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

export function v3StateToDeliveryLoopState(
  state: WorkflowStateV3,
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

export function isTerminalStateV3(state: WorkflowStateV3): boolean {
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
