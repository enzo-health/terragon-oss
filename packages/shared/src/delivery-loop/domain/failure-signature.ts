import type { DaemonFailure } from "./signals.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FailureSignature = {
  category: DaemonFailure["kind"];
  messageHash: number;
  source: "daemon" | "timer";
  firstSeenAt: string;
  consecutiveCount: number;
  totalCount: number;
};

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

const DEFAULT_POLICIES: Record<DaemonFailure["kind"], CircuitBreakerPolicy> = {
  runtime_crash: { maxConsecutive: 3, maxTotal: 6 },
  timeout: { maxConsecutive: 3, maxTotal: 6 },
  oom: { maxConsecutive: 2, maxTotal: 4 },
  config_error: { maxConsecutive: 1, maxTotal: 1 },
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
  const msgHash = hashFailureMessage(failureMessage(failure));
  const key = makeSignatureKey(failure.kind, msgHash);
  const existing = existingMap[key];

  const signature: FailureSignature = existing
    ? {
        ...existing,
        consecutiveCount: existing.consecutiveCount + 1,
        totalCount: existing.totalCount + 1,
      }
    : {
        category: failure.kind,
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
    sig.category === "runtime_crash" &&
    sig.messageHash === hashFailureMessage("Internal error")
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
