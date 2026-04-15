/**
 * Mirrors `BootingSubstatus` from `@terragon/sandbox/types`.  Duplicated here
 * so that `@terragon/shared` (which lists `@terragon/sandbox` only as a
 * devDependency) does not take a runtime dep on the sandbox package.
 */
export type BootingSubstatus =
  | "provisioning"
  | "provisioning-done"
  | "cloning-repo"
  | "installing-agent"
  | "running-setup-script"
  | "booting-done";

/**
 * ThreadMetaEvent — daemon-emitted events that carry operational metadata
 * (token usage, rate limits, model re-routing, MCP server health, session
 * initialisation) but are NOT chat messages.  They travel on a separate
 * channel from thread-chat content so that the UI can update status chips
 * without polluting the message stream.
 */
export type ThreadMetaEvent =
  | {
      kind: "thread.token_usage_updated";
      threadId: string;
      usage: {
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
      };
    }
  | {
      kind: "account.rate_limits_updated";
      rateLimits: Record<string, unknown>;
    }
  | {
      kind: "model.rerouted";
      threadId: string;
      originalModel: string;
      reroutedModel: string;
      reason: string;
    }
  | {
      kind: "mcp_server.startup_status_updated";
      serverName: string;
      status: "loading" | "ready" | "error";
      error?: string;
    }
  | {
      kind: "thread.status_changed";
      threadId: string;
      status: string;
    }
  | {
      kind: "config.warning";
      message: string;
      context?: string;
    }
  | {
      kind: "deprecation.notice";
      message: string;
      replacement?: string;
    }
  | {
      // Emitted when the Codex app-server session is fully initialized.
      kind: "session.initialized";
      tools: string[];
      mcpServers: string[];
    }
  | {
      // Emitted for each message_delta usage report from the Claude Code stream.
      kind: "usage.incremental";
      inputTokens: number;
      outputTokens: number;
      cacheCreation: number;
      cacheRead: number;
    }
  | {
      // Emitted when the Claude Code stream signals message stop.
      kind: "message.stop";
      reason: string;
    }
  | {
      // Emitted by the server when the sandbox booting substatus transitions.
      // `from` is null on the very first transition (no prior substatus recorded).
      // `durationMs` is absent when the previous transition timestamp is unavailable.
      kind: "boot.substatus_changed";
      threadId: string;
      from: BootingSubstatus | null;
      to: BootingSubstatus;
      timestamp: string; // ISO 8601
      durationMs?: number;
    }
  | {
      // Emitted during sandbox setup when package-install progress is observed.
      // Fields map to pnpm install output counters; `total` is omitted when
      // pnpm doesn't expose it.
      kind: "install.progress";
      threadId: string;
      resolved: number;
      reused: number;
      downloaded: number;
      added: number;
      total?: number;
      currentPackage?: string;
      elapsedMs: number;
    };

// Note: the narrate-only escalation no longer emits a dedicated meta event.
// The reducer transitions to `awaiting_manual_fix` and writes a human-readable
// `blockedReason` on the workflow head, which is published via the existing
// `publishStatusEffect` and rendered by the UI as part of the standard
// awaiting_manual_fix surface. A dedicated meta event would be additional
// noise without a distinct rendering path.
