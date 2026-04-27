/**
 * Mirrors `BootingSubstatus` from `@terragon/sandbox/types`. Duplicated here
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
 * initialisation) but are NOT chat messages. They travel on a separate
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
      kind: "session.initialized";
      tools: string[];
      mcpServers: string[];
    }
  | {
      kind: "usage.incremental";
      inputTokens: number;
      outputTokens: number;
      cacheCreation: number;
      cacheRead: number;
    }
  | {
      kind: "message.stop";
      reason: string;
    }
  | {
      kind: "boot.substatus_changed";
      threadId: string;
      from: BootingSubstatus | null;
      to: BootingSubstatus;
      timestamp: string;
      durationMs?: number;
    }
  | {
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
