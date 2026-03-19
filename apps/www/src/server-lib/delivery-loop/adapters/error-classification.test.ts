import { describe, it, expect } from "vitest";
import { classifyDaemonError, classifyDaemonEventError } from "./shared";
import { CodexImplementationAdapter } from "./codex-adapter";
import { ClaudeCodeImplementationAdapter } from "./claude-code-adapter";
import type { DeliveryLoopDaemonEvent } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTerminalEvent(
  overrides: Partial<DeliveryLoopDaemonEvent> = {},
): DeliveryLoopDaemonEvent {
  return {
    runId: "run-1",
    type: "terminal",
    isError: true,
    errorMessage: null,
    sessionId: null,
    headSha: null,
    exitCode: null,
    timestamp: new Date(),
    ...overrides,
  };
}

const codex = new CodexImplementationAdapter();
const claude = new ClaudeCodeImplementationAdapter();

// ---------------------------------------------------------------------------
// classifyDaemonError
// ---------------------------------------------------------------------------
describe("classifyDaemonError", () => {
  it("returns null for null message", () => {
    expect(classifyDaemonError(null, null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(classifyDaemonError("", null)).toBeNull();
  });

  // daemon_unreachable ---------------------------------------------------
  describe("daemon_unreachable", () => {
    const cases = [
      "unix socket not found",
      "ECONNREFUSED on port 3000",
      "ENOENT: no such socket file",
      "No such file or directory",
      "connect failed after 3 retries",
      "daemon not running",
      "daemon is dead",
      "ping failed: no response",
      "ECONNRESET by remote host",
      "EPIPE: broken pipe",
      "ENETUNREACH: network is unreachable",
      "EHOSTUNREACH: host unreachable",
      "ENETRESET: connection reset by network",
      "ECONNABORTED: connection aborted",
    ];
    it.each(cases)("classifies %j as daemon_unreachable", (msg) => {
      expect(classifyDaemonError(msg, null)).toBe("daemon_unreachable");
    });
  });

  // daemon_spawn_failed --------------------------------------------------
  describe("daemon_spawn_failed", () => {
    const cases = [
      "spawn /usr/bin/node ENOENT",
      "fork: resource temporarily unavailable",
      "exec format error",
      "EACCES: permission denied",
      "ENOENT: daemon binary missing",
      "Cannot find module '@terragon/daemon'",
      "ENOSPC: no space left on device",
      "disk full, cannot write",
      "No space left on device",
    ];
    it.each(cases)("classifies %j as daemon_spawn_failed", (msg) => {
      expect(classifyDaemonError(msg, null)).toBe("daemon_spawn_failed");
    });
  });

  // dispatch_ack_timeout (rate limiting) ----------------------------------
  describe("dispatch_ack_timeout — rate limiting", () => {
    const cases = [
      "rate limit exceeded",
      "HTTP 429 Too Many Requests",
      "too many requests, slow down",
      "throttled by upstream",
    ];
    it.each(cases)("classifies %j as dispatch_ack_timeout", (msg) => {
      expect(classifyDaemonError(msg, null)).toBe("dispatch_ack_timeout");
    });
  });

  // dispatch_ack_timeout (timeouts) ---------------------------------------
  describe("dispatch_ack_timeout — timeouts", () => {
    const cases = [
      "timeout waiting for response",
      "request timed out after 30s",
      "ack timeout: no response from daemon",
      "dispatch timeout exceeded",
    ];
    it.each(cases)("classifies %j as dispatch_ack_timeout", (msg) => {
      expect(classifyDaemonError(msg, null)).toBe("dispatch_ack_timeout");
    });
  });

  // config_error (auth / billing) -----------------------------------------
  describe("config_error", () => {
    const cases = [
      "invalid api key provided",
      "invalid credential: token expired",
      "authentication failed for user",
      "unauthorized: missing bearer token",
      "403 Forbidden",
      "quota exceeded for model gpt-4",
      "billing account suspended",
      "insufficient credit balance",
      "payment required to continue",
    ];
    it.each(cases)("classifies %j as config_error", (msg) => {
      expect(classifyDaemonError(msg, null)).toBe("config_error");
    });
  });

  // Unknown ---------------------------------------------------------------
  it("returns null for unrecognized message", () => {
    expect(
      classifyDaemonError("something completely unexpected", null),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyDaemonEventError
// ---------------------------------------------------------------------------
describe("classifyDaemonEventError", () => {
  it("returns 'unknown' for null message", () => {
    expect(classifyDaemonEventError(null)).toBe("unknown");
  });

  // Daemon-level (delegates to classifyDaemonError)
  it("classifies daemon-level errors via delegation", () => {
    expect(classifyDaemonEventError("ECONNREFUSED")).toBe("daemon_unreachable");
    expect(classifyDaemonEventError("spawn ENOENT")).toBe(
      "daemon_spawn_failed",
    );
    expect(classifyDaemonEventError("rate limit hit")).toBe(
      "dispatch_ack_timeout",
    );
    expect(classifyDaemonEventError("invalid api key")).toBe("config_error");
  });

  // Context window
  describe("context window → config_error", () => {
    const cases = [
      "context window exceeded",
      "ran out of room in the context",
      "context is too long for model",
      "token limit reached",
      "max tokens exceeded for request",
    ];
    it.each(cases)("classifies %j as config_error", (msg) => {
      expect(classifyDaemonEventError(msg)).toBe("config_error");
    });
  });

  // Codex-specific
  describe("codex patterns", () => {
    it("classifies codex app-server exit", () => {
      expect(classifyDaemonEventError("codex app-server exit code 1")).toBe(
        "codex_app_server_exit",
      );
      expect(classifyDaemonEventError("app_server crash detected")).toBe(
        "codex_app_server_exit",
      );
    });

    it("classifies codex subagent failure", () => {
      expect(classifyDaemonEventError("codex subagent returned error")).toBe(
        "codex_subagent_failed",
      );
      expect(classifyDaemonEventError("subagent fail: bad result")).toBe(
        "codex_subagent_failed",
      );
    });

    it("classifies codex turn failure", () => {
      expect(classifyDaemonEventError("codex turn failed")).toBe(
        "codex_turn_failed",
      );
      expect(classifyDaemonEventError("codex error: API returned 500")).toBe(
        "codex_turn_failed",
      );
    });
  });

  // Claude-specific
  describe("claude patterns", () => {
    it("classifies claude runtime exit", () => {
      expect(classifyDaemonEventError("claude exit code 1")).toBe(
        "claude_runtime_exit",
      );
      expect(classifyDaemonEventError("claude crash: segfault")).toBe(
        "claude_runtime_exit",
      );
      expect(classifyDaemonEventError("claude runtime error")).toBe(
        "claude_runtime_exit",
      );
    });

    it("classifies claude dispatch failure", () => {
      expect(classifyDaemonEventError("claude dispatch failed")).toBe(
        "claude_dispatch_failed",
      );
      expect(classifyDaemonEventError("dispatch failed: no sandbox")).toBe(
        "claude_dispatch_failed",
      );
    });
  });

  // Overloaded / capacity
  describe("overloaded → codex_turn_failed", () => {
    const cases = [
      "server overloaded, try again",
      "server busy please retry",
      "capacity exceeded for region",
      "service unavailable temporarily",
      "HTTP 503 Service Unavailable",
    ];
    it.each(cases)("classifies %j as codex_turn_failed", (msg) => {
      expect(classifyDaemonEventError(msg)).toBe("codex_turn_failed");
    });
  });

  // Gate patterns
  describe("gate patterns", () => {
    it("classifies gate failures", () => {
      expect(classifyDaemonEventError("gate failed: ci check red")).toBe(
        "gate_failed",
      );
      expect(classifyDaemonEventError("gate blocked by review")).toBe(
        "gate_failed",
      );
    });
  });

  // Unknown fallback
  it("returns 'unknown' for unrecognized message", () => {
    expect(classifyDaemonEventError("something completely unexpected")).toBe(
      "unknown",
    );
  });
});

// ---------------------------------------------------------------------------
// CodexImplementationAdapter.classifyTerminal (covers classifyCodexTerminalError + detectSubAgentUsage)
// ---------------------------------------------------------------------------
describe("CodexImplementationAdapter.classifyTerminal", () => {
  // Successful completion
  it("returns completed for non-error terminal event", () => {
    const update = codex.classifyTerminal(
      makeTerminalEvent({ isError: false }),
    );
    expect(update.runStatus).toBe("completed");
    expect(update.terminalErrorCategory).toBeNull();
  });

  // Null error message with non-zero exit code
  it("returns codex_app_server_exit for null message + non-zero exit", () => {
    const update = codex.classifyTerminal(
      makeTerminalEvent({ errorMessage: null, exitCode: 1 }),
    );
    expect(update.runStatus).toBe("failed");
    expect(update.terminalErrorCategory).toBe("codex_app_server_exit");
  });

  // Null error message with zero exit code
  it("returns unknown for null message + zero exit code", () => {
    const update = codex.classifyTerminal(
      makeTerminalEvent({ errorMessage: null, exitCode: 0 }),
    );
    expect(update.terminalErrorCategory).toBe("unknown");
  });

  // Null error message with null exit code
  it("returns unknown for null message + null exit code", () => {
    const update = codex.classifyTerminal(
      makeTerminalEvent({ errorMessage: null, exitCode: null }),
    );
    expect(update.terminalErrorCategory).toBe("unknown");
  });

  // Context window
  describe("context window → config_error", () => {
    const cases = [
      "context window overflow",
      "ran out of room in context",
      "context is too long",
      "token limit exceeded",
      "max tokens exceeded",
    ];
    it.each(cases)("classifies %j as config_error", (msg) => {
      const update = codex.classifyTerminal(
        makeTerminalEvent({ errorMessage: msg }),
      );
      expect(update.terminalErrorCategory).toBe("config_error");
    });
  });

  // Codex app-server exit
  it("classifies codex app-server exit", () => {
    const update = codex.classifyTerminal(
      makeTerminalEvent({ errorMessage: "codex app-server exit code 137" }),
    );
    expect(update.terminalErrorCategory).toBe("codex_app_server_exit");
  });

  it("classifies app_server crash", () => {
    const update = codex.classifyTerminal(
      makeTerminalEvent({ errorMessage: "app_server crash: OOM" }),
    );
    expect(update.terminalErrorCategory).toBe("codex_app_server_exit");
  });

  // Codex subagent
  it("classifies codex subagent failure", () => {
    const update = codex.classifyTerminal(
      makeTerminalEvent({ errorMessage: "codex subagent timeout" }),
    );
    expect(update.terminalErrorCategory).toBe("codex_subagent_failed");
  });

  it("classifies subagent fail", () => {
    const update = codex.classifyTerminal(
      makeTerminalEvent({ errorMessage: "subagent failed with error" }),
    );
    expect(update.terminalErrorCategory).toBe("codex_subagent_failed");
  });

  // Codex turn failure
  it("classifies codex turn failure", () => {
    const update = codex.classifyTerminal(
      makeTerminalEvent({ errorMessage: "codex turn failed: API error" }),
    );
    expect(update.terminalErrorCategory).toBe("codex_turn_failed");
  });

  it("classifies codex error", () => {
    const update = codex.classifyTerminal(
      makeTerminalEvent({ errorMessage: "codex error: invalid response" }),
    );
    expect(update.terminalErrorCategory).toBe("codex_turn_failed");
  });

  // Overloaded → codex_turn_failed
  describe("overloaded → codex_turn_failed", () => {
    const cases = [
      "server overloaded",
      "server busy",
      "capacity exceeded",
      "service unavailable",
      "503 error",
    ];
    it.each(cases)("classifies %j as codex_turn_failed", (msg) => {
      const update = codex.classifyTerminal(
        makeTerminalEvent({ errorMessage: msg }),
      );
      expect(update.terminalErrorCategory).toBe("codex_turn_failed");
    });
  });

  // Falls through to shared daemon classifier
  it("falls through to daemon_unreachable via shared classifier", () => {
    const update = codex.classifyTerminal(
      makeTerminalEvent({ errorMessage: "ECONNREFUSED" }),
    );
    expect(update.terminalErrorCategory).toBe("daemon_unreachable");
  });

  it("falls through to config_error via shared classifier (auth)", () => {
    const update = codex.classifyTerminal(
      makeTerminalEvent({ errorMessage: "invalid api key" }),
    );
    expect(update.terminalErrorCategory).toBe("config_error");
  });

  it("returns unknown for unrecognized error", () => {
    const update = codex.classifyTerminal(
      makeTerminalEvent({ errorMessage: "totally unknown error" }),
    );
    expect(update.terminalErrorCategory).toBe("unknown");
  });

  // Sub-agent detection via classifyTerminal
  describe("sub-agent detection (detectSubAgentUsage)", () => {
    it("detects subagent usage", () => {
      const update = codex.classifyTerminal(
        makeTerminalEvent({
          errorMessage: "subagent started processing",
          isError: false,
        }),
      );
      expect(update.usedSubAgents).toBe(true);
      expect(update.subAgentFailureCount).toBe(0);
    });

    it("detects collab_tool_call usage", () => {
      const update = codex.classifyTerminal(
        makeTerminalEvent({
          errorMessage: "collab_tool_call invoked for file edit",
          isError: false,
        }),
      );
      expect(update.usedSubAgents).toBe(true);
    });

    it("detects delegated sub usage", () => {
      const update = codex.classifyTerminal(
        makeTerminalEvent({
          errorMessage: "delegated sub task completed",
          isError: false,
        }),
      );
      expect(update.usedSubAgents).toBe(true);
    });

    it("counts sub-agent failure when error keywords present", () => {
      const update = codex.classifyTerminal(
        makeTerminalEvent({ errorMessage: "subagent failed with exit 1" }),
      );
      expect(update.usedSubAgents).toBe(true);
      expect(update.subAgentFailureCount).toBe(1);
    });

    it("does not detect sub-agents for unrelated messages", () => {
      const update = codex.classifyTerminal(
        makeTerminalEvent({
          errorMessage: "normal error occurred",
          isError: false,
        }),
      );
      expect(update.usedSubAgents).toBe(false);
      expect(update.subAgentFailureCount).toBe(0);
    });

    it("returns no sub-agent info when errorMessage is null", () => {
      const update = codex.classifyTerminal(
        makeTerminalEvent({ errorMessage: null, isError: false }),
      );
      expect(update.usedSubAgents).toBe(false);
      expect(update.subAgentFailureCount).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeImplementationAdapter.classifyTerminal (covers classifyClaudeTerminalError)
// ---------------------------------------------------------------------------
describe("ClaudeCodeImplementationAdapter.classifyTerminal", () => {
  // Successful completion
  it("returns completed for non-error terminal event", () => {
    const update = claude.classifyTerminal(
      makeTerminalEvent({ isError: false }),
    );
    expect(update.runStatus).toBe("completed");
    expect(update.terminalErrorCategory).toBeNull();
  });

  // Null error message with non-zero exit code
  it("returns claude_runtime_exit for null message + non-zero exit", () => {
    const update = claude.classifyTerminal(
      makeTerminalEvent({ errorMessage: null, exitCode: 1 }),
    );
    expect(update.runStatus).toBe("failed");
    expect(update.terminalErrorCategory).toBe("claude_runtime_exit");
  });

  // Null error message with zero exit code
  it("returns unknown for null message + zero exit code", () => {
    const update = claude.classifyTerminal(
      makeTerminalEvent({ errorMessage: null, exitCode: 0 }),
    );
    expect(update.terminalErrorCategory).toBe("unknown");
  });

  // Null error message with null exit code
  it("returns unknown for null message + null exit code", () => {
    const update = claude.classifyTerminal(
      makeTerminalEvent({ errorMessage: null, exitCode: null }),
    );
    expect(update.terminalErrorCategory).toBe("unknown");
  });

  // Context window → config_error
  describe("context window → config_error", () => {
    const cases = [
      "context window overflow",
      "ran out of room in context",
      "context is too long",
      "token limit exceeded",
      "max tokens exceeded",
    ];
    it.each(cases)("classifies %j as config_error", (msg) => {
      const update = claude.classifyTerminal(
        makeTerminalEvent({ errorMessage: msg }),
      );
      expect(update.terminalErrorCategory).toBe("config_error");
    });
  });

  // Overloaded → claude_runtime_exit
  describe("overloaded → claude_runtime_exit", () => {
    const cases = [
      "server overloaded",
      "server busy",
      "capacity exceeded",
      "service unavailable",
      "503 error",
    ];
    it.each(cases)("classifies %j as claude_runtime_exit", (msg) => {
      const update = claude.classifyTerminal(
        makeTerminalEvent({ errorMessage: msg }),
      );
      expect(update.terminalErrorCategory).toBe("claude_runtime_exit");
    });
  });

  // Claude dispatch failure
  it("classifies claude dispatch failure", () => {
    const update = claude.classifyTerminal(
      makeTerminalEvent({ errorMessage: "claude dispatch failed" }),
    );
    expect(update.terminalErrorCategory).toBe("claude_dispatch_failed");
  });

  it("classifies dispatch fail pattern", () => {
    const update = claude.classifyTerminal(
      makeTerminalEvent({ errorMessage: "dispatch failed: sandbox not ready" }),
    );
    expect(update.terminalErrorCategory).toBe("claude_dispatch_failed");
  });

  // Claude runtime exit / crash
  it("classifies claude exit", () => {
    const update = claude.classifyTerminal(
      makeTerminalEvent({ errorMessage: "claude exit code 137" }),
    );
    expect(update.terminalErrorCategory).toBe("claude_runtime_exit");
  });

  it("classifies claude crash", () => {
    const update = claude.classifyTerminal(
      makeTerminalEvent({ errorMessage: "claude crash: segfault" }),
    );
    expect(update.terminalErrorCategory).toBe("claude_runtime_exit");
  });

  it("classifies claude runtime error", () => {
    const update = claude.classifyTerminal(
      makeTerminalEvent({ errorMessage: "claude runtime panicked" }),
    );
    expect(update.terminalErrorCategory).toBe("claude_runtime_exit");
  });

  // Falls through to shared daemon classifier
  it("falls through to daemon_unreachable via shared classifier", () => {
    const update = claude.classifyTerminal(
      makeTerminalEvent({ errorMessage: "ECONNREFUSED" }),
    );
    expect(update.terminalErrorCategory).toBe("daemon_unreachable");
  });

  it("falls through to daemon_spawn_failed via shared classifier", () => {
    const update = claude.classifyTerminal(
      makeTerminalEvent({ errorMessage: "spawn ENOENT" }),
    );
    expect(update.terminalErrorCategory).toBe("daemon_spawn_failed");
  });

  it("falls through to dispatch_ack_timeout via shared classifier", () => {
    const update = claude.classifyTerminal(
      makeTerminalEvent({ errorMessage: "timeout waiting for response" }),
    );
    expect(update.terminalErrorCategory).toBe("dispatch_ack_timeout");
  });

  it("falls through to config_error via shared classifier (billing)", () => {
    const update = claude.classifyTerminal(
      makeTerminalEvent({ errorMessage: "billing account suspended" }),
    );
    expect(update.terminalErrorCategory).toBe("config_error");
  });

  it("returns unknown for unrecognized error", () => {
    const update = claude.classifyTerminal(
      makeTerminalEvent({ errorMessage: "totally unknown error" }),
    );
    expect(update.terminalErrorCategory).toBe("unknown");
  });

  // Diagnostics structure
  it("includes exitCode and failureCategory in diagnostics", () => {
    const update = claude.classifyTerminal(
      makeTerminalEvent({ errorMessage: "claude exit code 1", exitCode: 1 }),
    );
    expect(update.diagnostics).toEqual({
      exitCode: 1,
      failureCategory: "claude_runtime_exit",
    });
  });
});
