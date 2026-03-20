export type FailureCategory =
  | "daemon_unreachable"
  | "daemon_spawn_failed"
  | "dispatch_ack_timeout"
  | "codex_runtime_exit"
  | "claude_runtime_exit"
  | "gate_evaluation_failed"
  | "publication_failed"
  | "config_error"
  | "unknown";

export type FailureClassification =
  | { kind: "transient"; retryable: true; backoffMs: number }
  | { kind: "real_bug"; retryable: true; countsTowardBudget: true }
  | { kind: "infrastructure"; retryable: false; escalate: true }
  | { kind: "configuration"; retryable: false; escalate: true };

const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export function classifyFailure(
  category: FailureCategory,
): FailureClassification {
  switch (category) {
    case "daemon_unreachable":
    case "daemon_spawn_failed":
    case "dispatch_ack_timeout":
      return { kind: "transient", retryable: true, backoffMs: BASE_BACKOFF_MS };
    case "codex_runtime_exit":
    case "claude_runtime_exit":
    case "gate_evaluation_failed":
      return { kind: "real_bug", retryable: true, countsTowardBudget: true };
    case "publication_failed":
      return {
        kind: "transient",
        retryable: true,
        backoffMs: BASE_BACKOFF_MS * 3,
      };
    case "config_error":
      return { kind: "configuration", retryable: false, escalate: true };
    case "unknown":
      return { kind: "real_bug", retryable: true, countsTowardBudget: true };
  }
}

export function computeBackoffMs(params: {
  attempt: number;
  baseMs?: number;
  maxMs?: number;
}): number {
  const base = params.baseMs ?? BASE_BACKOFF_MS;
  const max = params.maxMs ?? MAX_BACKOFF_MS;
  return Math.min(max, base * 2 ** Math.max(0, params.attempt - 1));
}
