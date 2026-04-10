import type { DeliveryLoopFailureCategory } from "@leo/shared/delivery-loop/domain/failure";

/**
 * Classify daemon-level errors shared across all agent runtimes.
 * Returns a failure category if a daemon pattern matches, or `null`
 * so callers can try agent-specific patterns first.
 */
export function classifyDaemonError(
  rawErrorMessage: string | null,
  exitCode: number | null,
): DeliveryLoopFailureCategory | null {
  if (!rawErrorMessage) return null;

  // Network / connectivity — daemon unreachable.
  if (
    /unix socket|econnrefused|enoent.*socket|no such file|connect failed/i.test(
      rawErrorMessage,
    ) ||
    /daemon.*not running|daemon.*dead|ping.*fail/i.test(rawErrorMessage) ||
    /econnreset|epipe|enetunreach|ehostunreach|enetreset|econnaborted/i.test(
      rawErrorMessage,
    )
  ) {
    return "daemon_unreachable";
  }
  // Sandbox spawn / filesystem errors.
  if (
    /spawn|fork|exec|eacces|enoent.*daemon|cannot find module/i.test(
      rawErrorMessage,
    ) ||
    /enospc|disk full|no space left/i.test(rawErrorMessage)
  ) {
    return "daemon_spawn_failed";
  }

  // Explicit Codex transport classes.
  if (
    /context.?length.?exceeded|context.?window|ran out of room|exceeds the context window|max.*tokens.*exceeded|input length and max_tokens exceed context limit|prompt is too long|input exceeds the maximum length/i.test(
      rawErrorMessage,
    )
  ) {
    return "turn_input_too_large";
  }
  if (/provider not configured|invalid provider/i.test(rawErrorMessage)) {
    return "config_invalid_provider";
  }
  if (
    /codex.*app.?server.*exit.*mid.*turn|app.?server.*exit.*mid.*turn|app.?server.*crash.*mid.*turn/i.test(
      rawErrorMessage,
    )
  ) {
    return "app_server_exit_mid_turn";
  }
  if (
    /ws.*connect.*timeout|websocket.*connect.*timeout/i.test(rawErrorMessage)
  ) {
    return "ws_connect_timeout";
  }
  if (
    /codex.*subagent.*child|subagent.*child.*fail|child.*subagent.*fail/i.test(
      rawErrorMessage,
    )
  ) {
    return "subagent_child_failure";
  }

  // Rate limiting — transient, retry same intent.
  if (/rate.limit|429|too many requests|throttl/i.test(rawErrorMessage)) {
    return "dispatch_ack_timeout";
  }
  // Timeouts.
  if (
    (/timeout|timed out/i.test(rawErrorMessage) &&
      !/ws|websocket/i.test(rawErrorMessage)) ||
    /ack.*timeout|dispatch.*timeout|timed out waiting for ack/i.test(
      rawErrorMessage,
    )
  ) {
    return "dispatch_ack_timeout";
  }
  // Auth / API key / billing — non-retryable.
  if (
    /invalid api.key|invalid.credential|authentication fail|unauthorized|403 forbidden/i.test(
      rawErrorMessage,
    ) ||
    /quota.exceed|billing|insufficient.credit|payment required/i.test(
      rawErrorMessage,
    )
  ) {
    return "config_error";
  }

  return null;
}

/**
 * Comprehensive error classifier for analytics/telemetry — covers daemon,
 * Claude, Codex, and gate patterns. Used by handle-daemon-event.ts where
 * agent type is not known at classification time.
 */
export function classifyDaemonEventError(
  errorMessage: string | null,
): DeliveryLoopFailureCategory {
  if (!errorMessage) return "unknown";

  // Daemon-level patterns first.
  const daemonCategory = classifyDaemonError(errorMessage, null);
  if (daemonCategory) return daemonCategory;

  // Context window overflow — non-retryable with the same input.
  if (
    /context.?length.?exceeded|context.?window|ran out of room|exceeds the context window|max.*tokens.*exceeded|input length and max_tokens exceed context limit|prompt is too long|input exceeds the maximum length/i.test(
      errorMessage,
    )
  ) {
    return "turn_input_too_large";
  }

  // Codex-specific patterns.
  if (
    /codex.*app.?server.*exit.*mid.*turn|app.?server.*exit.*mid.*turn|app.?server.*crash.*mid.*turn/i.test(
      errorMessage,
    )
  )
    return "app_server_exit_mid_turn";
  if (/codex.*app.?server.*exit|app.?server.*crash/i.test(errorMessage))
    return "codex_app_server_exit";
  if (
    /codex.*subagent.*child|subagent.*child.*fail|child.*subagent.*fail/i.test(
      errorMessage,
    )
  )
    return "subagent_child_failure";
  if (/codex.*subagent|subagent.*fail/i.test(errorMessage))
    return "codex_subagent_failed";
  if (/codex.*turn.*fail|codex.*error/i.test(errorMessage))
    return "codex_turn_failed";

  if (/provider not configured|invalid provider/i.test(errorMessage))
    return "config_invalid_provider";

  if (/ws.*connect.*timeout|websocket.*connect.*timeout/i.test(errorMessage))
    return "ws_connect_timeout";

  // Claude-specific patterns.
  if (/claude.*exit|claude.*crash|claude.*runtime/i.test(errorMessage))
    return "claude_runtime_exit";
  if (/claude.*dispatch|dispatch.*fail/i.test(errorMessage))
    return "claude_dispatch_failed";

  // Overloaded / capacity — transient, retry.
  if (
    /overloaded|server busy|capacity exceeded|service unavailable|503/i.test(
      errorMessage,
    )
  )
    return "codex_turn_failed";

  // Gate patterns.
  if (/gate.*fail|gate.*block/i.test(errorMessage)) return "gate_failed";

  return "unknown";
}
