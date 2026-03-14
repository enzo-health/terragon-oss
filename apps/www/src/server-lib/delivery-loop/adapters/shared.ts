import type { DeliveryLoopFailureCategory } from "@terragon/shared/model/delivery-loop";
import type { NormalizedRunUpdate } from "./types";

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

  if (
    /unix socket|econnrefused|enoent.*socket|no such file|connect failed/i.test(
      rawErrorMessage,
    ) ||
    /daemon.*not running|daemon.*dead|ping.*fail/i.test(rawErrorMessage)
  ) {
    return "daemon_unreachable";
  }
  if (
    /spawn|fork|exec|eacces|enoent.*daemon|cannot find module/i.test(
      rawErrorMessage,
    )
  ) {
    return "daemon_spawn_failed";
  }
  if (
    /timeout|timed out|ack.*timeout|dispatch.*timeout/i.test(rawErrorMessage)
  ) {
    return "dispatch_ack_timeout";
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
    /context.window|ran out of room|context.*too long|token limit|max.*tokens.*exceeded/i.test(
      errorMessage,
    )
  )
    return "config_error";

  // Codex-specific patterns.
  if (/codex.*app.?server.*exit|app.?server.*crash/i.test(errorMessage))
    return "codex_app_server_exit";
  if (/codex.*subagent|subagent.*fail/i.test(errorMessage))
    return "codex_subagent_failed";
  if (/codex.*turn.*fail|codex.*error/i.test(errorMessage))
    return "codex_turn_failed";

  // Claude-specific patterns.
  if (/claude.*exit|claude.*crash|claude.*runtime/i.test(errorMessage))
    return "claude_runtime_exit";
  if (/claude.*dispatch|dispatch.*fail/i.test(errorMessage))
    return "claude_dispatch_failed";

  // Gate patterns.
  if (/gate.*fail|gate.*block/i.test(errorMessage)) return "gate_failed";

  return "unknown";
}

/**
 * Build a NormalizedRunUpdate with sensible defaults, overridden by the
 * provided partial.
 */
export function buildRunUpdate(
  runId: string,
  overrides: Partial<NormalizedRunUpdate>,
): NormalizedRunUpdate {
  return {
    runId,
    runStatus: "pending",
    dispatchStatus: "prepared",
    firstEventAt: null,
    completedAt: null,
    terminalErrorCategory: null,
    terminalErrorMessage: null,
    usedSubAgents: false,
    subAgentFailureCount: 0,
    sessionId: null,
    headShaAtCompletion: null,
    diagnostics: {},
    ...overrides,
  };
}
