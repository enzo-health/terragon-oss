import type {
  DeliveryEffectKindV3,
  DeliveryLoopState,
} from "@leo/shared/db/types";
import {
  type FailureLane,
  classifyFailureLane as classifyFailureLaneShared,
} from "@leo/shared/delivery-loop/domain/failure-signature";

export type WorkflowState =
  | "planning"
  | "implementing"
  // Legacy persisted state; normalize to implementing on read/reduce.
  | "awaiting_implementation_acceptance"
  | "gating_review"
  | "gating_ci"
  | "awaiting_pr_creation"
  | "awaiting_pr_lifecycle"
  | "awaiting_manual_fix"
  | "awaiting_operator_action"
  | "done"
  | "stopped"
  | "terminated";

export type LoopEvent =
  | { type: "bootstrap" }
  | {
      type: "planning_run_completed";
      runId?: string | null;
      runSeq?: number | null;
    }
  | { type: "plan_completed" }
  | {
      type: "plan_failed";
      reason: string;
      runId?: string | null;
      runSeq?: number | null;
    }
  | { type: "dispatch_queued"; runId: string; ackDeadlineAt: Date }
  | { type: "dispatch_claimed"; runId: string }
  | { type: "dispatch_accepted"; runId: string }
  // Legacy dispatch lifecycle events retained for compatibility.
  | { type: "dispatch_sent"; runId: string; ackDeadlineAt: Date }
  | { type: "dispatch_acked"; runId: string }
  | { type: "dispatch_ack_timeout"; runId: string }
  | {
      type: "run_completed";
      runId: string;
      runSeq?: number | null;
      headSha?: string | null;
    }
  | {
      type: "run_failed";
      runId: string;
      runSeq?: number | null;
      message: string;
      category: string | null;
      lane?: FailureLane;
    }
  | {
      type: "gate_review_passed";
      runId?: string | null;
      runSeq?: number | null;
      headSha?: string | null;
      prNumber?: number | null;
    }
  | { type: "pr_linked"; prNumber?: number | null }
  | {
      type: "gate_review_failed";
      runId?: string | null;
      runSeq?: number | null;
      reason?: string | null;
    }
  | {
      type: "gate_ci_passed";
      runId?: string | null;
      runSeq?: number | null;
      headSha?: string | null;
    }
  | {
      type: "gate_ci_failed";
      runId?: string | null;
      runSeq?: number | null;
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
      retryReason?: string | null;
    }
  | { kind: "dispatch_gate_review"; gate: "review" }
  | {
      kind: "run_lease_expiry_check";
      runId: string;
      workflowVersion: number;
    }
  | {
      // Legacy persisted effect kind retained during the migration window.
      kind: "ack_timeout_check";
      runId: string;
      workflowVersion: number;
    }
  | { kind: "ensure_pr" }
  | { kind: "create_plan_artifact" }
  | { kind: "publish_status" }
  | {
      kind: "gate_staleness_check";
      workflowVersion: number;
      pollCount?: number;
    };

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
  // run_lease_expiry_check results
  | { kind: "run_lease_expiry_check"; outcome: "fired"; runId: string }
  | { kind: "run_lease_expiry_check"; outcome: "stale" }
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
  activeRunSeq: number | null;
  leaseExpiresAt: Date | null;
  lastTerminalRunSeq: number | null;
  fixAttemptCount: number;
  infraRetryCount: number;
  maxFixAttempts: number;
  maxInfraRetries: number;
  blockedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date | null;
};

export type NormalizedPlanApprovalPolicy = "auto" | "human_required";

export function stateToDeliveryLoopState(
  state: WorkflowState | "awaiting_pr",
): DeliveryLoopState {
  switch (state) {
    case "planning":
      return "planning";
    case "implementing":
      return "implementing";
    case "awaiting_implementation_acceptance":
      return "implementing";
    case "gating_review":
      return "review_gate";
    case "gating_ci":
      return "ci_gate";
    case "awaiting_pr_creation":
    case "awaiting_pr_lifecycle":
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
      // TODO: stateToDeliveryLoopState only receives a WorkflowState string and
      // cannot distinguish terminated_pr_merged from terminated_pr_closed.
      // Use buildSnapshotFromV3Head (which has access to blockedReason) for
      // accurate terminal state mapping.
      return "terminated_pr_closed";
    default:
      // Defensive runtime fallback for unexpected persisted string values.
      return "blocked";
  }
}

export const AWAITING_PR_CREATION_REASON = "Awaiting PR creation";
export const TERMINAL_WORKFLOW_STATES = [
  "done",
  "stopped",
  "terminated",
] as const;
const TERMINAL_WORKFLOW_STATE_SET: ReadonlySet<WorkflowState> = new Set(
  TERMINAL_WORKFLOW_STATES,
);

export function isTerminalState(state: WorkflowState): boolean {
  return TERMINAL_WORKFLOW_STATE_SET.has(state);
}

export function normalizePlanApprovalPolicy(
  policy: string | null | undefined,
): NormalizedPlanApprovalPolicy {
  switch (policy) {
    case "human":
    case "human_required":
      return "human_required";
    case "auto":
    case null:
    case undefined:
    default:
      return "auto";
  }
}

export function normalizeEffectApprovalPolicy(
  policy: string | null | undefined,
): "auto" | "human" {
  return normalizePlanApprovalPolicy(policy) === "human_required"
    ? "human"
    : "auto";
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
