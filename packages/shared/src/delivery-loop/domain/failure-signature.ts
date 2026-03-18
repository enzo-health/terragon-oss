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

export function getPolicyForSignature(
  sig: FailureSignature,
): CircuitBreakerPolicy {
  if (isInfrastructureSignature(sig)) {
    return INFRA_POLICY;
  }
  return DEFAULT_POLICIES[sig.category];
}
