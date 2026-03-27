import type { DaemonFailure } from "./signals.js";
import type { DeliveryCodexTransportFailureClass } from "../../db/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FailureSignature = {
  category: FailureSignatureCategory;
  messageHash: number;
  source: "daemon" | "timer";
  firstSeenAt: string;
  consecutiveCount: number;
  totalCount: number;
};

export type FailureSignatureCategory =
  | DaemonFailure["kind"]
  | DeliveryCodexTransportFailureClass;

/** Keyed by `${category}:${messageHash}` */
export type FailureSignatureMap = Record<string, FailureSignature>;

export type CircuitBreakerPolicy = {
  maxConsecutive: number;
  maxTotal: number;
};

export type FailureLane = "agent" | "infra";

export type FailureClassifyInput = {
  category: string | null;
  message: string | null;
};

// ---------------------------------------------------------------------------
// Default policies per failure category
// ---------------------------------------------------------------------------

const DEFAULT_POLICIES: Record<FailureSignatureCategory, CircuitBreakerPolicy> =
  {
    runtime_crash: { maxConsecutive: 3, maxTotal: 6 },
    timeout: { maxConsecutive: 3, maxTotal: 6 },
    oom: { maxConsecutive: 2, maxTotal: 4 },
    config_error: { maxConsecutive: 1, maxTotal: 1 },
    turn_input_too_large: { maxConsecutive: 1, maxTotal: 1 },
    app_server_exit_mid_turn: { maxConsecutive: 3, maxTotal: 6 },
    ws_connect_timeout: { maxConsecutive: 3, maxTotal: 6 },
    config_invalid_provider: { maxConsecutive: 1, maxTotal: 1 },
    subagent_child_failure: { maxConsecutive: 3, maxTotal: 6 },
  };

const INFRA_POLICY: CircuitBreakerPolicy = {
  maxConsecutive: 10,
  maxTotal: 15,
};

const INFRA_FAILURE_MESSAGE_MARKERS = [
  "internal error",
  "couldn't connect to server",
  "could not connect to server",
  "acp",
  "sandbox-not-found",
  "daemon not running",
  "daemon dead",
  "sigkill",
  "sigterm",
  "pathspec",
  "daemon failed to start",
  "module_not_found",
  "out of memory",
  "oom",
  "codex app-server exited unexpectedly",
  "ws connect timeout",
] as const;

const TURN_INPUT_TOO_LARGE_PATTERNS = [
  /context.?length.?exceeded/i,
  /context.?window/i,
  /ran out of room/i,
  /exceeds the context window/i,
  /max.*tokens.*exceeded/i,
  /input length and max_tokens exceed context limit/i,
  /prompt is too long/i,
  /input exceeds the maximum length/i,
] as const;

const APP_SERVER_EXIT_MID_TURN_PATTERNS = [
  /app.?server.*exit.*mid.*turn/i,
  /codex.*app.?server.*exit.*mid.*turn/i,
  /app.?server.*crash.*mid.*turn/i,
] as const;

const WS_CONNECT_TIMEOUT_PATTERNS = [
  /ws.*connect.*timeout/i,
  /websocket.*connect.*timeout/i,
  /codex.*websocket.*timeout/i,
] as const;

const CONFIG_INVALID_PROVIDER_PATTERNS = [
  /provider not configured/i,
  /invalid provider/i,
] as const;

const SUBAGENT_CHILD_FAILURE_PATTERNS = [
  /subagent.*child.*fail/i,
  /child.*subagent.*fail/i,
] as const;

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/** djb2 hash — stable 32-bit integer from a string. */
export function hashFailureMessage(msg: string): number {
  let hash = 5381;
  for (let i = 0; i < msg.length; i++) {
    // hash * 33 + charCode, kept in 32-bit signed range
    hash = ((hash << 5) + hash + msg.charCodeAt(i)) | 0;
  }
  return hash;
}

export function makeSignatureKey(
  category: string,
  messageHash: number,
): string {
  return `${category}:${messageHash}`;
}

/** Extract the failure message for hashing (normalised across failure kinds). */
function failureMessage(failure: DaemonFailure): string {
  switch (failure.kind) {
    case "runtime_crash":
    case "config_error":
      return failure.message;
    case "timeout":
      return `timeout:${failure.durationMs}`;
    case "oom":
      return `oom:${failure.durationMs}`;
  }
}

function classifyCodexTransportFailureCategory(
  failure: DaemonFailure,
): FailureSignatureCategory {
  const message = failureMessage(failure).toLowerCase();

  switch (failure.kind) {
    case "runtime_crash":
      if (
        TURN_INPUT_TOO_LARGE_PATTERNS.some((pattern) => pattern.test(message))
      ) {
        return "turn_input_too_large";
      }
      if (
        APP_SERVER_EXIT_MID_TURN_PATTERNS.some((pattern) =>
          pattern.test(message),
        )
      ) {
        return "app_server_exit_mid_turn";
      }
      if (
        WS_CONNECT_TIMEOUT_PATTERNS.some((pattern) => pattern.test(message))
      ) {
        return "ws_connect_timeout";
      }
      if (
        SUBAGENT_CHILD_FAILURE_PATTERNS.some((pattern) => pattern.test(message))
      ) {
        return "subagent_child_failure";
      }
      return "runtime_crash";
    case "config_error":
      if (
        CONFIG_INVALID_PROVIDER_PATTERNS.some((pattern) =>
          pattern.test(message),
        )
      ) {
        return "config_invalid_provider";
      }
      return "config_error";
    case "timeout":
      return "timeout";
    case "oom":
      return "oom";
  }
}

/**
 * Creates or updates a failure signature entry in the map.
 * Returns the key, updated signature, and a new map (immutable).
 */
export function extractFailureSignature(
  failure: DaemonFailure,
  source: "daemon" | "timer",
  existingMap: FailureSignatureMap,
  now: Date,
): {
  key: string;
  signature: FailureSignature;
  updatedMap: FailureSignatureMap;
} {
  const category = classifyCodexTransportFailureCategory(failure);
  const msgHash = hashFailureMessage(failureMessage(failure));
  const key = makeSignatureKey(category, msgHash);
  const existing = existingMap[key];

  const signature: FailureSignature = existing
    ? {
        ...existing,
        consecutiveCount: existing.consecutiveCount + 1,
        totalCount: existing.totalCount + 1,
      }
    : {
        category,
        messageHash: msgHash,
        source,
        firstSeenAt: now.toISOString(),
        consecutiveCount: 1,
        totalCount: 1,
      };

  return {
    key,
    signature,
    updatedMap: { ...existingMap, [key]: signature },
  };
}

export function isSameSignature(
  a: FailureSignature,
  b: FailureSignature,
): boolean {
  return a.category === b.category && a.messageHash === b.messageHash;
}

export function shouldTripCircuitBreaker(
  signature: FailureSignature,
  policy: CircuitBreakerPolicy,
): boolean {
  return (
    signature.consecutiveCount >= policy.maxConsecutive ||
    signature.totalCount >= policy.maxTotal
  );
}

/**
 * Checks if this signature matches the ACP transient "Internal error" pattern.
 */
export function isInfrastructureSignature(sig: FailureSignature): boolean {
  return (
    sig.category === "ws_connect_timeout" ||
    (sig.category === "runtime_crash" &&
      sig.messageHash === hashFailureMessage("Internal error"))
  );
}

/**
 * Classifies a terminal failure into infra vs agent lane.
 *
 * Deterministic and explicit to avoid heuristic drift.
 */
export function classifyFailureLane(params: FailureClassifyInput): FailureLane {
  if (isInfrastructureFailure(params)) {
    return "infra";
  }
  return "agent";
}

/**
 * Infra-only detector for explicit failure categories/messages.
 */
export function isInfrastructureFailure(params: FailureClassifyInput): boolean {
  const category = (params.category ?? "").toLowerCase().trim();
  const message = (params.message ?? "").toLowerCase().trim();

  if (category === "dispatch_ack_timeout") {
    return true;
  }

  if (category === "runtime_crash" && message.includes("internal error")) {
    return true;
  }

  if (category === "transport" || category === "infra") {
    return true;
  }

  if (category === "ws_connect_timeout") {
    return true;
  }

  // Sandbox resume / agent crash categories from the daemon
  if (
    category === "sandbox-resume-failed" ||
    category === "sandbox_resume_failed" ||
    category === "agent-generic-error"
  ) {
    return true;
  }

  // Compound message patterns (multi-keyword)
  if (message.includes("checkout") && message.includes("failed")) {
    return true;
  }
  if (message.includes("branch") && message.includes("not found")) {
    return true;
  }
  if (message.includes("sandbox") && message.includes("failed")) {
    return true;
  }

  return INFRA_FAILURE_MESSAGE_MARKERS.some(
    (marker) => message.includes(marker) || category.includes(marker),
  );
}

export function getPolicyForSignature(
  sig: FailureSignature,
): CircuitBreakerPolicy {
  if (isInfrastructureSignature(sig)) {
    return INFRA_POLICY;
  }
  return DEFAULT_POLICIES[sig.category];
}
