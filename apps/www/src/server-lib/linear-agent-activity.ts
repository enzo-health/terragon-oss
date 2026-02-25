/**
 * Linear Agent activity emission helpers.
 *
 * Uses `LinearClient.createAgentActivity()` from @linear/sdk (typed SDK — no raw GraphQL).
 * Activity content shapes per Linear Agent Interaction docs:
 *   - thought: { type: "thought", body: string }
 *   - action:  { type: "action", action: string, result?: string }
 *   - response: { type: "response", body: string }
 *   - error:   { type: "error", body: string }
 */

import { LinearClient } from "@linear/sdk";
import type { ClaudeMessage } from "@terragon/daemon/shared";
import type { ThreadSourceMetadata } from "@terragon/shared/db/types";
import { db } from "@/lib/db";
import { refreshLinearTokenIfNeeded } from "@/server-lib/linear-oauth";

/**
 * Input shape for an external URL on a Linear agent session.
 * Mirrors AgentSessionExternalUrlInput from @linear/sdk (not publicly exported).
 */
export type AgentSessionExternalUrlInput = {
  /** Human-readable label for the external URL. */
  label: string;
  /** The external URL. */
  url: string;
};

/** Injectable factory type for testability. */
export type LinearClientFactory = (accessToken: string) => LinearClient;

/** Default factory creates a LinearClient with OAuth access token. */
const defaultClientFactory: LinearClientFactory = (accessToken: string) =>
  new LinearClient({ accessToken });

export type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; result?: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

/**
 * Emit a Linear agent activity for a session.
 *
 * All errors are caught and logged — never throws.
 *
 * @param opts.agentSessionId - Linear agent session ID
 * @param opts.accessToken - OAuth access token for the workspace installation
 * @param opts.content - Activity content (typed per Linear API shapes)
 * @param opts.createClient - Injectable factory for testability (defaults to real LinearClient)
 */
export async function emitAgentActivity({
  agentSessionId,
  accessToken,
  content,
  createClient = defaultClientFactory,
}: {
  agentSessionId: string;
  accessToken: string;
  content: AgentActivityContent;
  createClient?: LinearClientFactory;
}): Promise<void> {
  try {
    const client = createClient(accessToken);
    await client.createAgentActivity({
      agentSessionId,
      content,
    });
  } catch (error) {
    console.error("[linear-agent-activity] Failed to emit activity", {
      agentSessionId,
      contentType: content.type,
      error,
    });
  }
}

/**
 * Update the Linear agent session with external URLs (e.g. Terragon task URL).
 *
 * All errors are caught and logged — never throws.
 *
 * @param opts.sessionId - Linear agent session ID
 * @param opts.accessToken - OAuth access token for the workspace installation
 * @param opts.externalUrls - Array of { label, url } objects to set on the session
 * @param opts.createClient - Injectable factory for testability
 */
export async function updateAgentSession({
  sessionId,
  accessToken,
  externalUrls,
  createClient = defaultClientFactory,
}: {
  sessionId: string;
  accessToken: string;
  externalUrls: AgentSessionExternalUrlInput[];
  createClient?: LinearClientFactory;
}): Promise<void> {
  try {
    const client = createClient(accessToken);
    await client.updateAgentSession(sessionId, { externalUrls });
  } catch (error) {
    console.error("[linear-agent-activity] Failed to update agent session", {
      sessionId,
      externalUrls,
      error,
    });
  }
}

// ---------------------------------------------------------------------------
// Throttle state (in-memory, module-level)
// ---------------------------------------------------------------------------

/**
 * Tracks last `action` activity emission timestamp per agentSessionId.
 * In-memory throttle is acceptable here — worst case of lost state on cold start
 * is one extra activity emission, which is harmless. No DB-level guard needed.
 */
const lastActionEmitMap = new Map<string, number>();

/** Max 1 `action` activity per session per this interval (ms). */
const ACTION_THROTTLE_MS = 30_000;

/** Max chars for progress summary extracted from assistant messages. */
const SUMMARY_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// Helper: extract last assistant text from daemon messages
// ---------------------------------------------------------------------------

function extractLastAssistantText(messages: ClaudeMessage[]): string | null {
  // Walk backwards to find the last assistant message with text content
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.type !== "assistant") continue;

    const content = msg.message.content;
    if (typeof content === "string" && content.trim()) {
      return content.slice(0, SUMMARY_MAX_CHARS);
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          return block.text.slice(0, SUMMARY_MAX_CHARS);
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

type LinearMentionMetadata = Extract<
  ThreadSourceMetadata,
  { type: "linear-mention" }
>;

/**
 * Emit Linear agent activities based on daemon event messages.
 *
 * - `action` activities are throttled to max 1 per 30 seconds per agentSessionId.
 * - `response`/`error` terminal activities always bypass the throttle.
 * - All emissions are wrapped in try/catch — never throws, never blocks thread processing.
 *
 * @param sourceMetadata - The thread's linear-mention source metadata (already validated)
 * @param messages - Daemon event messages for this batch
 * @param opts.isDone - Whether the thread completed successfully
 * @param opts.isError - Whether the thread errored
 * @param opts.customErrorMessage - Error message if isError is true
 * @param opts.costUsd - Cost in USD if isDone
 * @param opts.now - Injectable clock for testing throttle behavior (defaults to Date.now)
 * @param opts.createClient - Injectable LinearClient factory for testing
 */
export async function emitLinearActivitiesForDaemonEvent(
  sourceMetadata: LinearMentionMetadata,
  messages: ClaudeMessage[],
  opts?: {
    isDone?: boolean;
    isError?: boolean;
    customErrorMessage?: string | null;
    costUsd?: number;
    now?: () => number;
    createClient?: LinearClientFactory;
  },
): Promise<void> {
  const agentSessionId = sourceMetadata.agentSessionId;
  if (!agentSessionId) {
    // Legacy fn-1 thread without agentSessionId — skip gracefully
    console.warn(
      "[linear-agent-activity] Skipping Linear activity: legacy thread missing agentSessionId",
      { organizationId: sourceMetadata.organizationId },
    );
    return;
  }

  const organizationId = sourceMetadata.organizationId;
  const nowFn = opts?.now ?? (() => Date.now());
  const createClient = opts?.createClient ?? defaultClientFactory;

  // Refresh token before emitting
  let accessToken: string;
  try {
    const tokenResult = await refreshLinearTokenIfNeeded(organizationId, db);
    if (tokenResult.status !== "ok") {
      console.warn(
        "[linear-agent-activity] Skipping activity: token not available",
        { organizationId, status: tokenResult.status },
      );
      return;
    }
    accessToken = tokenResult.accessToken;
  } catch (error) {
    console.error(
      "[linear-agent-activity] Token refresh failed, skipping activity",
      { organizationId, error },
    );
    return;
  }

  const isDone = opts?.isDone ?? false;
  const isError = opts?.isError ?? false;

  // Terminal events: response or error — always emit (bypass throttle)
  if (isDone && !isError) {
    // Build a brief result summary
    const lastText = extractLastAssistantText(messages);
    let body = "Task completed.";
    if (lastText) {
      body = lastText;
    }
    if (opts?.costUsd && opts.costUsd > 0) {
      body += ` (cost: $${opts.costUsd.toFixed(4)})`;
    }

    await emitAgentActivity({
      agentSessionId,
      accessToken,
      content: { type: "response", body },
      createClient,
    });
    return;
  }

  if (isError) {
    const errorMsg =
      opts?.customErrorMessage?.trim() || "Agent encountered an error.";
    await emitAgentActivity({
      agentSessionId,
      accessToken,
      content: { type: "error", body: errorMsg },
      createClient,
    });
    return;
  }

  // Non-terminal: emit `action` activity if throttle allows
  const now = nowFn();
  const lastEmit = lastActionEmitMap.get(agentSessionId);
  if (lastEmit !== undefined && now - lastEmit < ACTION_THROTTLE_MS) {
    // Throttled — skip this batch
    return;
  }

  const summary = extractLastAssistantText(messages);
  if (!summary) {
    // No assistant text in this batch — nothing useful to emit
    return;
  }

  await emitAgentActivity({
    agentSessionId,
    accessToken,
    content: { type: "action", action: summary },
    createClient,
  });

  // Update throttle map
  lastActionEmitMap.set(agentSessionId, now);
}
