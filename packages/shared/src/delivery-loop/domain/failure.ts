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
