import type { SdlcLoopState, SdlcPhase } from "../../db/types";

const activeSdlcLoopStates = [
  "planning",
  "implementing",
  "review_gate",
  "ci_gate",
  "ui_gate",
  "awaiting_pr_link",
  "babysitting",
  "blocked",
] as const satisfies readonly SdlcLoopState[];
export const activeSdlcLoopStateList: SdlcLoopState[] = [
  ...activeSdlcLoopStates,
];
export const activeSdlcLoopStateSet: ReadonlySet<SdlcLoopState> = new Set(
  activeSdlcLoopStateList,
);

const terminalSdlcLoopStates = [
  "terminated_pr_closed",
  "terminated_pr_merged",
  "done",
  "stopped",
] as const satisfies readonly SdlcLoopState[];
export const terminalSdlcLoopStateList: SdlcLoopState[] = [
  ...terminalSdlcLoopStates,
];
export const terminalSdlcLoopStateSet: ReadonlySet<SdlcLoopState> = new Set(
  terminalSdlcLoopStateList,
);

/**
 * Categorises the root cause of a delivery-loop dispatch failure so that
 * downstream retry logic can make an informed decision (retry, reboot sandbox,
 * or surface to the user).
 */
export type DeliveryLoopFailureCategory =
  | "daemon_unreachable"
  | "daemon_spawn_failed"
  | "dispatch_ack_timeout"
  | "codex_app_server_exit"
  | "codex_turn_failed"
  | "codex_subagent_failed"
  | "claude_runtime_exit"
  | "claude_dispatch_failed"
  | "gate_failed"
  | "config_error"
  | "unknown";

/**
 * Retry action to take for a given failure category.
 * - rerun_prepare_and_retry: Re-run sandbox preparation (daemon health check)
 *   then retry the dispatch. Appropriate when the daemon may have died.
 * - retry_same_intent: Retry the same dispatch without re-preparing.
 *   Appropriate for transient transport issues.
 * - retry_if_budget: Retry only if the retry budget hasn't been exhausted.
 *   Appropriate for runtime crashes that may or may not recur.
 * - return_to_implementing: The failure indicates the current phase output is
 *   bad; loop back to implementing to re-attempt.
 * - blocked: Non-retryable. Surface the error to the user.
 */
export type DeliveryLoopRetryAction =
  | "rerun_prepare_and_retry"
  | "retry_same_intent"
  | "retry_if_budget"
  | "return_to_implementing"
  | "blocked";

export const DELIVERY_LOOP_FAILURE_ACTION_TABLE: Record<
  DeliveryLoopFailureCategory,
  DeliveryLoopRetryAction
> = {
  daemon_unreachable: "rerun_prepare_and_retry",
  daemon_spawn_failed: "rerun_prepare_and_retry",
  dispatch_ack_timeout: "retry_same_intent",
  codex_app_server_exit: "retry_if_budget",
  codex_turn_failed: "retry_if_budget",
  codex_subagent_failed: "return_to_implementing",
  claude_runtime_exit: "retry_if_budget",
  claude_dispatch_failed: "rerun_prepare_and_retry",
  gate_failed: "return_to_implementing",
  config_error: "blocked",
  unknown: "retry_if_budget",
};

/**
 * Execution class determines which runtime handles the dispatch.
 */
export type DeliveryLoopExecutionClass =
  | "implementation_runtime"
  | "gate_runtime";

/**
 * Mechanism used to dispatch work to the sandbox daemon.
 */
export type DeliveryLoopDispatchMechanism = "self_dispatch" | "queue_fallback";

/**
 * A durable record of a dispatch intent. Persisted before any dispatch
 * so that failed dispatches are recoverable. Stored in Redis with a TTL;
 * DB migration comes later.
 */
export type DeliveryLoopDispatchIntent = {
  id: string;
  loopId: string;
  threadId: string;
  threadChatId: string;
  targetPhase: import("./types").DeliveryLoopDispatchablePhase;
  selectedAgent: import("./types").DeliveryLoopSelectedAgent;
  executionClass: DeliveryLoopExecutionClass;
  dispatchMechanism: DeliveryLoopDispatchMechanism;
  runId: string;
  status: import("./types").DeliveryLoopDispatchStatus;
  retryCount: number;
  maxRetries: number;
  createdAt: Date;
  updatedAt: Date;
  lastError: string | null;
  lastFailureCategory: DeliveryLoopFailureCategory | null;
};

export type SdlcLoopTransitionEvent =
  | "plan_completed"
  | "plan_gate_blocked"
  | "implementation_gate_blocked"
  | "implementation_completed"
  | "review_passed"
  | "review_blocked"
  | "ui_smoke_passed"
  | "ui_smoke_failed"
  | "pr_linked"
  | "babysit_passed"
  | "babysit_blocked"
  // Legacy transition events kept for compatibility while callsites migrate.
  | "implementation_progress"
  | "ci_gate_passed"
  | "ci_gate_blocked"
  | "review_threads_gate_passed"
  | "review_threads_gate_blocked"
  | "deep_review_gate_passed"
  | "deep_review_gate_blocked"
  | "carmack_review_gate_passed"
  | "carmack_review_gate_blocked"
  | "video_capture_started"
  | "video_capture_succeeded"
  | "video_capture_failed"
  | "human_feedback_requested"
  | "blocked_resume_requested"
  | "blocked_bypass_once_requested"
  | "pr_closed_unmerged"
  | "pr_merged"
  | "manual_stop"
  | "mark_done";

import type { SdlcPlanTaskStatus } from "../../db/types";

const sdlcPlanTaskNonBlockingTerminalStatusSet = new Set<SdlcPlanTaskStatus>([
  "done",
  "skipped",
]);

const sdlcPlanTaskIncompleteStatusSet = new Set<SdlcPlanTaskStatus>([
  "todo",
  "in_progress",
  "blocked",
]);

export function isIncompletePlanTaskStatus(
  status: SdlcPlanTaskStatus,
): boolean {
  return sdlcPlanTaskIncompleteStatusSet.has(status);
}

export function isNonBlockingTerminalPlanTaskStatus(
  status: SdlcPlanTaskStatus,
): boolean {
  return sdlcPlanTaskNonBlockingTerminalStatusSet.has(status);
}

export type SdlcLoopArtifactPointerField =
  | "activePlanArtifactId"
  | "activeImplementationArtifactId"
  | "activeReviewArtifactId"
  | "activeUiArtifactId"
  | "activeBabysitArtifactId";

export const phaseToLoopPointerColumn: Record<
  SdlcPhase,
  SdlcLoopArtifactPointerField | null
> = {
  planning: "activePlanArtifactId",
  implementing: "activeImplementationArtifactId",
  review_gate: "activeReviewArtifactId",
  ci_gate: null,
  ui_gate: "activeUiArtifactId",
  awaiting_pr_link: null,
  babysitting: "activeBabysitArtifactId",
};

export function isSdlcLoopTerminalState(state: SdlcLoopState): boolean {
  return terminalSdlcLoopStateSet.has(state);
}

export type SdlcGuardrailReasonCode =
  | "kill_switch"
  | "terminal_state"
  | "lease_invalid"
  | "cooldown"
  | "max_iterations"
  | "manual_intent_denied";

export function evaluateSdlcLoopGuardrails({
  killSwitchEnabled,
  isTerminalState,
  hasValidLease,
  cooldownUntil,
  iterationCount,
  maxIterations,
  manualIntentAllowed,
  now = new Date(),
}: {
  killSwitchEnabled: boolean;
  isTerminalState: boolean;
  hasValidLease: boolean;
  cooldownUntil: Date | null;
  iterationCount: number;
  maxIterations: number | null;
  manualIntentAllowed: boolean;
  now?: Date;
}):
  | { allowed: true }
  | { allowed: false; reasonCode: SdlcGuardrailReasonCode } {
  if (killSwitchEnabled) {
    return { allowed: false, reasonCode: "kill_switch" };
  }

  if (isTerminalState) {
    return { allowed: false, reasonCode: "terminal_state" };
  }

  if (!hasValidLease) {
    return { allowed: false, reasonCode: "lease_invalid" };
  }

  if (cooldownUntil && cooldownUntil > now) {
    return { allowed: false, reasonCode: "cooldown" };
  }

  if (maxIterations !== null && iterationCount >= maxIterations) {
    return { allowed: false, reasonCode: "max_iterations" };
  }

  if (!manualIntentAllowed) {
    return { allowed: false, reasonCode: "manual_intent_denied" };
  }

  return { allowed: true };
}
