import { describe, expect, it } from "vitest";
import type { DaemonFailure } from "./signals.js";
import {
  hashFailureMessage,
  makeSignatureKey,
  extractFailureSignature,
  isSameSignature,
  shouldTripCircuitBreaker,
  isInfrastructureFailure,
  isInfrastructureSignature,
  classifyFailureLane,
  getPolicyForSignature,
  type FailureSignature,
} from "./failure-signature.js";

const NOW = new Date("2025-01-01T00:00:00Z");

// ---------------------------------------------------------------------------
// hashFailureMessage
// ---------------------------------------------------------------------------

describe("hashFailureMessage", () => {
  it("returns a stable integer for the same input", () => {
    const h1 = hashFailureMessage("Internal error");
    const h2 = hashFailureMessage("Internal error");
    expect(h1).toBe(h2);
    expect(Number.isInteger(h1)).toBe(true);
  });

  it("returns different hashes for different inputs", () => {
    const h1 = hashFailureMessage("Internal error");
    const h2 = hashFailureMessage("Segfault");
    expect(h1).not.toBe(h2);
  });

  it("handles empty string", () => {
    const h = hashFailureMessage("");
    expect(h).toBe(5381); // djb2 initial value
  });
});

// ---------------------------------------------------------------------------
// makeSignatureKey
// ---------------------------------------------------------------------------

describe("makeSignatureKey", () => {
  it("formats category:hash", () => {
    expect(makeSignatureKey("runtime_crash", 12345)).toBe(
      "runtime_crash:12345",
    );
  });
});

// ---------------------------------------------------------------------------
// extractFailureSignature
// ---------------------------------------------------------------------------

describe("extractFailureSignature", () => {
  it("creates a new signature when none exists", () => {
    const failure: DaemonFailure = {
      kind: "runtime_crash",
      exitCode: 1,
      message: "crash",
    };
    const { key, signature, updatedMap } = extractFailureSignature(
      failure,
      "daemon",
      {},
      NOW,
    );

    expect(key).toContain("runtime_crash:");
    expect(signature.category).toBe("runtime_crash");
    expect(signature.consecutiveCount).toBe(1);
    expect(signature.totalCount).toBe(1);
    expect(signature.source).toBe("daemon");
    expect(signature.firstSeenAt).toBe(NOW.toISOString());
    expect(updatedMap[key]).toBe(signature);
  });

  it("increments counts for an existing signature", () => {
    const failure: DaemonFailure = {
      kind: "runtime_crash",
      exitCode: 1,
      message: "crash",
    };
    const { updatedMap: map1 } = extractFailureSignature(
      failure,
      "daemon",
      {},
      NOW,
    );
    const { signature: sig2, updatedMap: map2 } = extractFailureSignature(
      failure,
      "daemon",
      map1,
      new Date("2025-01-01T00:01:00Z"),
    );

    expect(sig2.consecutiveCount).toBe(2);
    expect(sig2.totalCount).toBe(2);
    // firstSeenAt should be preserved
    expect(sig2.firstSeenAt).toBe(NOW.toISOString());
    expect(Object.keys(map2)).toHaveLength(1);
  });

  it("creates separate entries for different failure messages", () => {
    const f1: DaemonFailure = {
      kind: "runtime_crash",
      exitCode: 1,
      message: "crash A",
    };
    const f2: DaemonFailure = {
      kind: "runtime_crash",
      exitCode: 1,
      message: "crash B",
    };
    const { updatedMap: map1 } = extractFailureSignature(f1, "daemon", {}, NOW);
    const { updatedMap: map2 } = extractFailureSignature(
      f2,
      "daemon",
      map1,
      NOW,
    );
    expect(Object.keys(map2)).toHaveLength(2);
  });

  it("handles timeout failures", () => {
    const failure: DaemonFailure = { kind: "timeout", durationMs: 60000 };
    const { signature } = extractFailureSignature(failure, "timer", {}, NOW);
    expect(signature.category).toBe("timeout");
    expect(signature.source).toBe("timer");
  });

  it("handles oom failures", () => {
    const failure: DaemonFailure = { kind: "oom", durationMs: 30000 };
    const { signature } = extractFailureSignature(failure, "daemon", {}, NOW);
    expect(signature.category).toBe("oom");
  });

  const knownTransportFailures: Array<[DaemonFailure, string]> = [
    [
      {
        kind: "runtime_crash",
        exitCode: 1,
        message: "context window exceeded during codex turn",
      },
      "turn_input_too_large",
    ],
    [
      {
        kind: "runtime_crash",
        exitCode: 1,
        message: "Input exceeds the maximum length of 1048576 characters.",
      },
      "turn_input_too_large",
    ],
    [
      {
        kind: "runtime_crash",
        exitCode: 1,
        message: "codex app-server exited mid turn",
      },
      "app_server_exit_mid_turn",
    ],
    [
      {
        kind: "runtime_crash",
        exitCode: 1,
        message: "ws connect timeout while establishing transport",
      },
      "ws_connect_timeout",
    ],
    [
      {
        kind: "config_error",
        message: "provider not configured for codex transport",
      },
      "config_invalid_provider",
    ],
    [
      {
        kind: "runtime_crash",
        exitCode: 1,
        message: "subagent child failed with exit code 1",
      },
      "subagent_child_failure",
    ],
  ];

  it.each(knownTransportFailures)(
    "maps known transport signatures to explicit categories",
    (failure, expectedCategory) => {
      const { signature } = extractFailureSignature(failure, "daemon", {}, NOW);
      expect(signature.category).toBe(expectedCategory);
    },
  );
});

// ---------------------------------------------------------------------------
// isSameSignature
// ---------------------------------------------------------------------------

describe("isSameSignature", () => {
  const base: FailureSignature = {
    category: "runtime_crash",
    messageHash: 123,
    source: "daemon",
    firstSeenAt: NOW.toISOString(),
    consecutiveCount: 1,
    totalCount: 1,
  };

  it("returns true for matching category + messageHash", () => {
    const other = { ...base, consecutiveCount: 5, totalCount: 10 };
    expect(isSameSignature(base, other)).toBe(true);
  });

  it("returns false for different category", () => {
    const other = { ...base, category: "timeout" as const };
    expect(isSameSignature(base, other)).toBe(false);
  });

  it("returns false for different messageHash", () => {
    const other = { ...base, messageHash: 456 };
    expect(isSameSignature(base, other)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldTripCircuitBreaker
// ---------------------------------------------------------------------------

describe("shouldTripCircuitBreaker", () => {
  const sig: FailureSignature = {
    category: "runtime_crash",
    messageHash: 123,
    source: "daemon",
    firstSeenAt: NOW.toISOString(),
    consecutiveCount: 1,
    totalCount: 1,
  };

  it("returns false when under both limits", () => {
    expect(
      shouldTripCircuitBreaker(sig, { maxConsecutive: 3, maxTotal: 6 }),
    ).toBe(false);
  });

  it("trips on consecutive >= maxConsecutive", () => {
    const tripped = { ...sig, consecutiveCount: 3 };
    expect(
      shouldTripCircuitBreaker(tripped, { maxConsecutive: 3, maxTotal: 6 }),
    ).toBe(true);
  });

  it("trips on total >= maxTotal", () => {
    const tripped = { ...sig, totalCount: 6 };
    expect(
      shouldTripCircuitBreaker(tripped, { maxConsecutive: 3, maxTotal: 6 }),
    ).toBe(true);
  });

  it("trips when both limits exceeded", () => {
    const tripped = { ...sig, consecutiveCount: 5, totalCount: 10 };
    expect(
      shouldTripCircuitBreaker(tripped, { maxConsecutive: 3, maxTotal: 6 }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isInfrastructureSignature
// ---------------------------------------------------------------------------

describe("isInfrastructureSignature", () => {
  it("returns true for runtime_crash with Internal error hash", () => {
    const sig: FailureSignature = {
      category: "runtime_crash",
      messageHash: hashFailureMessage("Internal error"),
      source: "daemon",
      firstSeenAt: NOW.toISOString(),
      consecutiveCount: 1,
      totalCount: 1,
    };
    expect(isInfrastructureSignature(sig)).toBe(true);
  });

  it("returns false for runtime_crash with different message", () => {
    const sig: FailureSignature = {
      category: "runtime_crash",
      messageHash: hashFailureMessage("Segfault"),
      source: "daemon",
      firstSeenAt: NOW.toISOString(),
      consecutiveCount: 1,
      totalCount: 1,
    };
    expect(isInfrastructureSignature(sig)).toBe(false);
  });

  it("returns false for non-runtime_crash category", () => {
    const sig: FailureSignature = {
      category: "timeout",
      messageHash: hashFailureMessage("Internal error"),
      source: "daemon",
      firstSeenAt: NOW.toISOString(),
      consecutiveCount: 1,
      totalCount: 1,
    };
    expect(isInfrastructureSignature(sig)).toBe(false);
  });

  it("returns true for ws_connect_timeout signatures", () => {
    const sig: FailureSignature = {
      category: "ws_connect_timeout",
      messageHash: hashFailureMessage("ws connect timeout"),
      source: "daemon",
      firstSeenAt: NOW.toISOString(),
      consecutiveCount: 1,
      totalCount: 1,
    };
    expect(isInfrastructureSignature(sig)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyFailureLane / isInfrastructureFailure
// ---------------------------------------------------------------------------

describe("isInfrastructureFailure", () => {
  it("classifies runtime_crash + Internal error as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "runtime_crash",
        message: "Internal error",
      }),
    ).toBe(true);
  });

  it("classifies dispatch ack timeout as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "dispatch_ack_timeout",
        message: "run timed out waiting for ack",
      }),
    ).toBe(true);
  });

  it("classifies transport-related daemon messages as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "transport",
        message: "socket hang up",
      }),
    ).toBe(true);
  });

  it("does not classify normal runtime crash as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "runtime_crash",
        message: "Segmentation fault",
      }),
    ).toBe(false);
  });

  it("classifies sandbox-resume-failed category as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "sandbox-resume-failed",
        message: "could not resume sandbox",
      }),
    ).toBe(true);
  });

  it("classifies sandbox_resume_failed category as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "sandbox_resume_failed",
        message: "resume error",
      }),
    ).toBe(true);
  });

  it("classifies agent-generic-error category as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "agent-generic-error",
        message: "codex crashed",
      }),
    ).toBe(true);
  });

  it("classifies ws_connect_timeout category as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "ws_connect_timeout",
        message: "websocket connect timeout",
      }),
    ).toBe(true);
  });

  it("classifies SIGKILL message as infra (OOM kill)", () => {
    expect(
      isInfrastructureFailure({
        category: "runtime_crash",
        message: "Process exited with SIGKILL",
      }),
    ).toBe(true);
  });

  it("classifies SIGTERM message as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "runtime_crash",
        message: "Process terminated by SIGTERM",
      }),
    ).toBe(true);
  });

  it("classifies pathspec message as infra (git checkout failure)", () => {
    expect(
      isInfrastructureFailure({
        category: "runtime_crash",
        message: "error: pathspec 'feature/xyz' did not match any file(s)",
      }),
    ).toBe(true);
  });

  it("classifies checkout + failed message as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "runtime_crash",
        message: "git checkout failed with exit code 1",
      }),
    ).toBe(true);
  });

  it("classifies branch + not found message as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "runtime_crash",
        message: "branch 'feature/abc' not found in remote",
      }),
    ).toBe(true);
  });

  it("classifies daemon failed to start message as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "runtime_crash",
        message: "daemon failed to start after 30s",
      }),
    ).toBe(true);
  });

  it("classifies sandbox + failed message as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "runtime_crash",
        message: "sandbox setup failed",
      }),
    ).toBe(true);
  });

  it("classifies MODULE_NOT_FOUND message as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "runtime_crash",
        message: "Error: Cannot find module MODULE_NOT_FOUND leo-daemon",
      }),
    ).toBe(true);
  });

  it("classifies OOM / out of memory as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "runtime_crash",
        message: "JavaScript heap out of memory",
      }),
    ).toBe(true);
  });

  it("classifies codex app-server exited unexpectedly as infra", () => {
    expect(
      isInfrastructureFailure({
        category: "runtime_crash",
        message: "codex app-server exited unexpectedly with code 137",
      }),
    ).toBe(true);
  });
});

describe("classifyFailureLane", () => {
  it("routes infra failures to the infra lane", () => {
    expect(
      classifyFailureLane({
        category: "runtime_crash",
        message: "couldn't connect to server",
      }),
    ).toBe("infra");
  });

  it("routes terminal runtime failures to the agent lane", () => {
    expect(
      classifyFailureLane({
        category: "runtime_crash",
        message: "segmentation fault",
      }),
    ).toBe("agent");
  });
});

// ---------------------------------------------------------------------------
// getPolicyForSignature
// ---------------------------------------------------------------------------

describe("getPolicyForSignature", () => {
  it("returns infra policy for infrastructure signatures", () => {
    const sig: FailureSignature = {
      category: "runtime_crash",
      messageHash: hashFailureMessage("Internal error"),
      source: "daemon",
      firstSeenAt: NOW.toISOString(),
      consecutiveCount: 1,
      totalCount: 1,
    };
    const policy = getPolicyForSignature(sig);
    expect(policy.maxConsecutive).toBe(10);
    expect(policy.maxTotal).toBe(15);
  });

  it("returns default policy for runtime_crash (non-infra)", () => {
    const sig: FailureSignature = {
      category: "runtime_crash",
      messageHash: hashFailureMessage("Segfault"),
      source: "daemon",
      firstSeenAt: NOW.toISOString(),
      consecutiveCount: 1,
      totalCount: 1,
    };
    const policy = getPolicyForSignature(sig);
    expect(policy.maxConsecutive).toBe(3);
    expect(policy.maxTotal).toBe(6);
  });

  it("returns oom policy for oom failures", () => {
    const sig: FailureSignature = {
      category: "oom",
      messageHash: hashFailureMessage("oom:30000"),
      source: "daemon",
      firstSeenAt: NOW.toISOString(),
      consecutiveCount: 1,
      totalCount: 1,
    };
    const policy = getPolicyForSignature(sig);
    expect(policy.maxConsecutive).toBe(2);
    expect(policy.maxTotal).toBe(4);
  });

  it("returns config_error policy (immediate trip)", () => {
    const sig: FailureSignature = {
      category: "config_error",
      messageHash: hashFailureMessage("bad config"),
      source: "daemon",
      firstSeenAt: NOW.toISOString(),
      consecutiveCount: 1,
      totalCount: 1,
    };
    const policy = getPolicyForSignature(sig);
    expect(policy.maxConsecutive).toBe(1);
    expect(policy.maxTotal).toBe(1);
  });

  it("returns infra policy for ws_connect_timeout", () => {
    const sig: FailureSignature = {
      category: "ws_connect_timeout",
      messageHash: hashFailureMessage("ws connect timeout"),
      source: "daemon",
      firstSeenAt: NOW.toISOString(),
      consecutiveCount: 1,
      totalCount: 1,
    };
    const policy = getPolicyForSignature(sig);
    expect(policy.maxConsecutive).toBe(10);
    expect(policy.maxTotal).toBe(15);
  });
});
