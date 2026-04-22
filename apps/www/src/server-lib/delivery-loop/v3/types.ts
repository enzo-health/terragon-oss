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
  | { type: "dispatch_ack_timeout"; runId: string }
  | { type: "dispatch_sent"; runId: string }
  | { type: "dispatch_acked"; runId: string }
  | {
      type: "run_completed";
      runId: string;
      runSeq?: number | null;
      headSha?: string | null;
      /**
       * Whether the agent invoked at least one tool call during this run.
       * Used to detect narration-only loops (agent responds with prose but
       * never calls any tools), triggering escalation to awaiting_manual_fix
       * after NO_PROGRESS_RETRY_THRESHOLD consecutive such retries.
       */
      hasToolCalls?: boolean;
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
  | {
      // Emitted when the CI gate polling budget (MAX_GATE_STALENESS_POLLS) is
      // exhausted without CI completing. Surfaces the workflow as
      // awaiting_operator_action instead of silently soft-deadlocking in
      // gating_ci.
      type: "gate_ci_stale";
      headSha?: string | null;
      reason: string;
    }
  | { type: "resume_requested" }
  | { type: "stop_requested" }
  | { type: "pr_closed"; merged: boolean }
  | {
      // Wake a thread whose workflow is in a terminal state so the agent can
      // triage a new GitHub event (review comment, CI failure, push, etc.) on
      // the already-shipped PR. Emitted by the GitHub webhook handlers when
      // the matched workflow is already done / stopped / terminated.
      type: "workflow_resurrected";
      reason: string;
      cause:
        | "check_failure"
        | "review_comment"
        | "pr_comment"
        | "pr_review"
        | "pr_reopened"
        | "pr_synchronize";
    };

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
 * Handlers return data; they never call kernel advance APIs directly.
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
  | { kind: "gate_staleness_check"; outcome: "stale" }
  // Polling budget exhausted without CI completing — surfaces the workflow as
  // awaiting_operator_action so an operator can investigate the stuck gate
  // instead of leaving it sitting silently in gating_ci.
  | {
      kind: "gate_staleness_check";
      outcome: "budget_exhausted";
      reason: string;
    };

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
  /**
   * Counts consecutive implementation retries where the agent produced
   * zero tool calls (narration-only). Resets to 0 when a run makes tool calls.
   * When this reaches NO_PROGRESS_RETRY_THRESHOLD the reducer escalates to
   * awaiting_manual_fix instead of scheduling another retry.
   */
  narrationOnlyRetryCount: number;
  /**
   * Timestamp of the most recent workflow_resurrected transition. Used by the
   * reducer to enforce a cooldown so a user with PR write access cannot
   * trigger a wake-storm of back-to-back dispatches by posting many comments
   * in quick succession. Null means the workflow has never been resurrected
   * (first resurrection always fires).
   */
  lastResurrectedAt: Date | null;
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
      // Use buildSnapshotFromHead (which has access to blockedReason) for
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

/**
 * States in which the Terragon Delivery Loop GitHub check should be reported
 * as `status: "completed"`. This is a superset of `isTerminalState`: we also
 * include `awaiting_pr_lifecycle` so branch-protection rules that gate merge
 * on Terragon's check can see a green signal while the workflow waits for the
 * user to merge / close the PR.
 */
export function shouldReportCheckCompleted(state: WorkflowState): boolean {
  return isTerminalState(state) || state === "awaiting_pr_lifecycle";
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
