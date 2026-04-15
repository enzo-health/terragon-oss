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
    };

// Note: the narrate-only escalation no longer emits a dedicated meta event.
// The reducer transitions to `awaiting_manual_fix` and writes a human-readable
// `blockedReason` on the workflow head, which is published via the existing
// `publishStatusEffect` and rendered by the UI as part of the standard
// awaiting_manual_fix surface. A dedicated meta event would be additional
// noise without a distinct rendering path.
