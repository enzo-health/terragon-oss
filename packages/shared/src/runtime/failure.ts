export type RuntimeFailureCategory =
  | "daemon_unreachable"
  | "daemon_spawn_failed"
  | "dispatch_ack_timeout"
  | "turn_input_too_large"
  | "app_server_exit_mid_turn"
  | "ws_connect_timeout"
  | "config_invalid_provider"
  | "subagent_child_failure"
  | "codex_app_server_exit"
  | "codex_turn_failed"
  | "codex_subagent_failed"
  | "claude_runtime_exit"
  | "claude_dispatch_failed"
  | "gate_failed"
  | "config_error"
  | "usage_limit"
  | "unknown";

type RuntimeRetryAction =
  | "rerun_prepare_and_retry"
  | "retry_same_intent"
  | "retry_if_budget"
  | "return_to_implementing"
  | "blocked";

export const RUNTIME_FAILURE_ACTION_TABLE: Record<
  RuntimeFailureCategory,
  RuntimeRetryAction
> = {
  daemon_unreachable: "rerun_prepare_and_retry",
  daemon_spawn_failed: "rerun_prepare_and_retry",
  dispatch_ack_timeout: "retry_same_intent",
  turn_input_too_large: "blocked",
  app_server_exit_mid_turn: "retry_if_budget",
  ws_connect_timeout: "retry_same_intent",
  config_invalid_provider: "blocked",
  subagent_child_failure: "return_to_implementing",
  codex_app_server_exit: "retry_if_budget",
  codex_turn_failed: "retry_if_budget",
  codex_subagent_failed: "return_to_implementing",
  claude_runtime_exit: "retry_if_budget",
  claude_dispatch_failed: "rerun_prepare_and_retry",
  gate_failed: "return_to_implementing",
  config_error: "blocked",
  // A usage/quota limit is not a transient runtime crash. Retrying before the
  // reset just burns another failed run, so it is blocked rather than retried.
  usage_limit: "blocked",
  unknown: "retry_if_budget",
};

export type DaemonTerminalErrorCategory =
  | "provider_not_configured"
  | "acp_sse_not_found"
  | "daemon_custom_error"
  | "daemon_result_error"
  | "unknown";

export function classifyDaemonTerminalErrorCategory(
  errorMessage: string | null,
): DaemonTerminalErrorCategory {
  if (!errorMessage) {
    return "unknown";
  }
  if (errorMessage.includes("provider not configured")) {
    return "provider_not_configured";
  }
  if (errorMessage.includes("SSE failed (404")) {
    return "acp_sse_not_found";
  }
  return "daemon_custom_error";
}

export function mapDaemonTerminalCategoryToRuntimeFailureCategory(
  category: DaemonTerminalErrorCategory,
  errorMessage?: string | null,
): RuntimeFailureCategory {
  if (
    errorMessage &&
    /context.?length.?exceeded|context.?window|ran out of room|exceeds the context window|max.*tokens.*exceeded/i.test(
      errorMessage,
    )
  ) {
    return "config_error";
  }

  // Usage/quota limits (Claude "usage limit reached", Codex "you've hit your
  // usage limit") are not retryable runtime crashes. Classify them distinctly
  // so they are surfaced and not retried before the reset window.
  if (
    errorMessage &&
    /usage limit reached|hit your usage limit/i.test(errorMessage)
  ) {
    return "usage_limit";
  }

  switch (category) {
    case "provider_not_configured":
      return "config_invalid_provider";
    case "acp_sse_not_found":
      return "daemon_unreachable";
    case "daemon_custom_error":
    case "daemon_result_error":
      return "claude_runtime_exit";
    case "unknown":
      return "unknown";
  }
}

export function hashRuntimeFailureMessage(message: string): number {
  let hash = 5381;
  for (let i = 0; i < message.length; i++) {
    hash = ((hash << 5) + hash + message.charCodeAt(i)) | 0;
  }
  return hash;
}
