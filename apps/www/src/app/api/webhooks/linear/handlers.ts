import { AgentActivitySignal } from "@linear/sdk";
import { env } from "@terragon/env/apps-www";
import { getLinearInstallationForOrg } from "@terragon/shared/model/linear";
import {
  getThread,
  getThreadByLinearAgentSessionId,
} from "@terragon/shared/model/threads";
import { getPrimaryThreadChat } from "@terragon/shared/utils/thread-utils";
import { decryptValue } from "@terragon/utils/encryption";
import { db } from "@/lib/db";
import { getDefaultModel } from "@/server-lib/default-ai-model";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import {
  emitAgentActivity,
  type LinearClientFactory,
} from "@/server-lib/linear-agent-activity";
import { refreshLinearTokenIfNeeded } from "@/server-lib/linear-oauth";
import { stopThread } from "@/server-lib/stop-thread";
import {
  createLinearIssueThread,
  LINEAR_ASSIGNMENT_PROMPT_FOOTER,
  LINEAR_ASSIGNMENT_PROMPT_PREFIX,
  parseGithubRepoFullName,
} from "./thread-creation";

// ---------------------------------------------------------------------------
// Webhook payload types (mirrors @linear/sdk AgentSessionEventWebhookPayload)
// ---------------------------------------------------------------------------

interface AgentSessionChild {
  id: string;
  creatorId?: string | null;
  issueId?: string | null;
  issue?: {
    id: string;
    identifier: string;
    title: string;
    url: string;
  } | null;
}

interface AgentSessionCreatedPayload {
  type: "AgentSessionEvent";
  action: "created";
  organizationId: string;
  /** Formatted prompt string with issue details, comments, and guidance. */
  promptContext?: string | null;
  agentSession: AgentSessionChild;
}

interface AgentSessionPromptedPayload {
  type: "AgentSessionEvent";
  action: "prompted";
  organizationId: string;
  promptContext?: string | null;
  agentSession: AgentSessionChild;
  agentActivity?: {
    content?: {
      type?: string;
      body?: string;
    };
    signal?: string | null;
    signalMetadata?: Record<string, unknown> | null;
  } | null;
}

export type AgentSessionEventPayload =
  | AgentSessionCreatedPayload
  | AgentSessionPromptedPayload
  | {
      type: "AgentSessionEvent";
      action: string;
      organizationId: string;
      agentSession: { id: string };
    };

export interface AppUserNotificationPayload {
  type: "AppUserNotification";
  action?: string;
  createdAt?: string;
  organizationId: string;
  notification?: {
    type?: string;
    user?: { id?: string };
    issue?: { id?: string; identifier?: string; team?: { id?: string } };
  };
}

export interface PermissionChangePayload {
  type: "PermissionChange";
  action: "teamAccessChanged";
  createdAt: string;
  organizationId: string;
  canAccessAllPublicTeams: boolean;
  addedTeamIds: string[];
  removedTeamIds: string[];
}

export interface OAuthAppRevokedPayload {
  type: "OAuthApp";
  action: "revoked";
  organizationId: string;
}

// Window in which a `prompted` event arriving on a brand-new thread is
// treated as the redundant pair of its `created` event rather than a real
// follow-up. See handleAgentSessionPrompted for the full guard.
const FRESH_THREAD_DEDUP_WINDOW_MS = 30_000;

export function isLinearBootstrapPromptDuplicate({
  promptBody,
  issueIdentifier,
}: {
  promptBody: string;
  issueIdentifier?: string | null;
}): boolean {
  if (!issueIdentifier?.trim()) {
    return false;
  }
  const normalizedPromptBody = promptBody.trim().replace(/\s+/g, " ");
  return (
    normalizedPromptBody.startsWith(
      `${LINEAR_ASSIGNMENT_PROMPT_PREFIX} ${issueIdentifier}:`,
    ) && normalizedPromptBody.includes(LINEAR_ASSIGNMENT_PROMPT_FOOTER)
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Race a promise against a cancellable timeout budget.
 * Unlike `Promise.race([p, new Promise(setTimeout)])`, this clears the timer
 * on success so it does not linger in the event loop.
 *
 * Rejects with the timeout error if `p` does not settle within `ms`.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Timeout after ${ms}ms`));
      }
    }, ms);
    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      },
    );
  });
}

/**
 * Emit an error agent activity using the installation's stale access token
 * as a best-effort fallback. Guards against:
 *   - decryptValue throwing (invalid ciphertext / wrong key)
 *   - emitAgentActivity hanging indefinitely (bounded by `budgetMs`)
 *
 * Never throws — always resolves.
 */
async function emitErrorActivityBestEffort({
  agentSessionId,
  accessTokenEncrypted,
  body,
  budgetMs = 2000,
  createClient,
}: {
  agentSessionId: string;
  accessTokenEncrypted: string;
  body: string;
  budgetMs?: number;
  createClient?: LinearClientFactory;
}): Promise<void> {
  let fallbackToken: string;
  try {
    fallbackToken = decryptValue(
      accessTokenEncrypted,
      env.ENCRYPTION_MASTER_KEY,
    );
  } catch (decryptErr) {
    console.error(
      "[linear webhook] Could not decrypt fallback token for error activity",
      { agentSessionId, decryptErr },
    );
    return;
  }

  // Bounded emission — do not block the webhook response beyond budgetMs.
  await new Promise<void>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        console.error(
          "[linear webhook] Error activity emission timed out (best-effort)",
          { agentSessionId },
        );
        resolve();
      }
    }, budgetMs);
    emitAgentActivity({
      agentSessionId,
      accessToken: fallbackToken,
      content: { type: "error", body },
      createClient,
    })
      .then(() => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve();
        }
      })
      .catch((err) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          console.error("[linear webhook] Error activity emission failed", {
            agentSessionId,
            err,
          });
          resolve();
        }
      });
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Handle AgentSessionEvent webhooks.
 * `created` events are the primary trigger for thread creation.
 * `prompted` events route follow-up input to existing threads.
 */
export async function handleAgentSessionEvent(
  payload: AgentSessionEventPayload,
  deliveryId: string | undefined,
  opts?: { createClient?: LinearClientFactory },
): Promise<void> {
  const { organizationId } = payload;
  const agentSessionId = payload.agentSession.id;

  console.log("[linear webhook] AgentSessionEvent", {
    action: payload.action,
    agentSessionId,
    organizationId,
  });

  if (payload.action === "created") {
    await handleAgentSessionCreated(
      payload as AgentSessionCreatedPayload,
      deliveryId,
      opts,
    );
  } else if (payload.action === "prompted") {
    await handleAgentSessionPrompted(
      payload as AgentSessionPromptedPayload,
      deliveryId,
      opts,
    );
  } else {
    console.log("[linear webhook] Unknown AgentSessionEvent action, skipping", {
      action: payload.action,
      agentSessionId,
    });
  }
}

async function handleAgentSessionCreated(
  payload: AgentSessionCreatedPayload,
  deliveryId: string | undefined,
  opts?: { createClient?: LinearClientFactory },
): Promise<void> {
  const { organizationId } = payload;
  const agentSessionId = payload.agentSession.id;

  // 1. Look up linearInstallation by organizationId
  const installation = await getLinearInstallationForOrg({
    db,
    organizationId,
  });
  if (!installation || !installation.isActive) {
    console.error(
      "[linear webhook] No active linearInstallation for org, skipping",
      { organizationId },
    );
    return;
  }

  // 1b. Pre-flight: validate payload fields that require no DB before emitting thought.
  // This prevents optimistic "Starting work..." from appearing when we will silently skip.
  const preflightIssueId =
    payload.agentSession.issueId ?? payload.agentSession.issue?.id;
  const preflightActorId = payload.agentSession.creatorId;

  if (!preflightIssueId) {
    console.error(
      "[linear webhook] Pre-flight: no issueId in agentSession, skipping",
      { agentSessionId },
    );
    return;
  }
  if (!preflightActorId) {
    console.error(
      "[linear webhook] Pre-flight: no creatorId in agentSession, skipping",
      { agentSessionId },
    );
    return;
  }

  // 2. Token refresh with 2.5s hard budget (cancellable — timer is cleared on success)
  let accessToken: string;
  try {
    const result = await withTimeout(
      refreshLinearTokenIfNeeded(organizationId, db),
      2500,
    );
    if (result.status !== "ok") {
      // Reinstall required — best-effort error activity, bounded + guarded.
      console.error("[linear webhook] Token refresh: reinstall required", {
        organizationId,
      });
      await emitErrorActivityBestEffort({
        agentSessionId,
        accessTokenEncrypted: installation.accessTokenEncrypted,
        body: "Authentication failure — please reinstall the Linear Agent",
        createClient: opts?.createClient,
      });
      return;
    }
    accessToken = result.accessToken;
  } catch (err) {
    // Timeout or other error — best-effort error activity, bounded + guarded.
    console.error(
      "[linear webhook] Token refresh timed out or failed, returning 200",
      { agentSessionId, err },
    );
    await emitErrorActivityBestEffort({
      agentSessionId,
      accessTokenEncrypted: installation.accessTokenEncrypted,
      body: "Authentication failure — please reinstall the Linear Agent",
      createClient: opts?.createClient,
    });
    return;
  }

  // 3. Synchronously emit `thought` activity BEFORE returning HTTP 200 (<10s SLA).
  // emitAgentActivity catches all errors internally, so this call never throws.
  // Use a cancellable timeout guard to avoid false-positive timeout logs when
  // the activity resolves quickly.
  await new Promise<void>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        console.error(
          "[linear webhook] Thought emission timed out (SLA guard), continuing",
          { agentSessionId },
        );
        resolve();
      }
    }, 3000);
    emitAgentActivity({
      agentSessionId,
      accessToken,
      content: {
        type: "thought",
        body: "Starting work on this issue...",
      },
      ephemeral: true,
      createClient: opts?.createClient,
    })
      .then(() => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve();
        }
      })
      .catch((err) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          console.error(
            "[linear webhook] Thought emission failed (SLA guard), continuing",
            { agentSessionId, err },
          );
          resolve();
        }
      });
  });

  await createLinearIssueThread({
    organizationId,
    agentSession: payload.agentSession,
    promptContext: payload.promptContext ?? null,
    deliveryId,
    accessToken,
    appUserId: installation.appUserId,
    createClient: opts?.createClient,
  });
}

async function handleAgentSessionPrompted(
  payload: AgentSessionPromptedPayload,
  deliveryId: string | undefined,
  opts?: { createClient?: LinearClientFactory },
): Promise<void> {
  const { organizationId } = payload;
  const agentSessionId = payload.agentSession.id;

  // Handle the stop signal — user clicked "Stop" in Linear
  if (payload.agentActivity?.signal === AgentActivitySignal.Stop) {
    // Look up thread by agentSessionId
    const thread = await getThreadByLinearAgentSessionId({
      db,
      agentSessionId,
      organizationId,
    });
    if (thread) {
      console.log("[linear webhook] Stop signal received, stopping thread", {
        agentSessionId,
        threadId: thread.id,
      });

      // Fetch full thread to resolve the active threadChat
      const threadFull = await getThread({
        db,
        threadId: thread.id,
        userId: thread.userId,
      });
      if (threadFull) {
        try {
          const primaryChat = getPrimaryThreadChat(threadFull);
          await stopThread({
            userId: thread.userId,
            threadId: thread.id,
            threadChatId: primaryChat.id,
          });
        } catch (err) {
          console.error(
            "[linear webhook] Failed to stop thread for stop signal",
            {
              agentSessionId,
              threadId: thread.id,
              err,
            },
          );
        }
      }
    } else {
      console.warn(
        "[linear webhook] Stop signal: no thread found for agentSessionId",
        { agentSessionId },
      );
    }
    return;
  }

  // Look up thread by agentSessionId
  const thread = await getThreadByLinearAgentSessionId({
    db,
    agentSessionId,
    organizationId,
  });
  if (!thread) {
    await handlePreThreadPrompted(payload, deliveryId, opts);
    return;
  }

  // Backward compat: skip legacy fn-1 threads that have no agentSessionId in metadata
  const meta = thread.sourceMetadata;
  if (meta?.type !== "linear-mention" || !meta.agentSessionId) {
    console.log(
      "[linear webhook] Legacy thread without agentSessionId, skipping prompted event",
      { threadId: thread.id },
    );
    return;
  }

  // Extract the user's follow-up message from the agent activity content,
  // falling back to the formatted promptContext string.
  const promptBody =
    payload.agentActivity?.content?.body ?? payload.promptContext ?? "";

  // Skip empty prompts — no useful work to queue
  if (!promptBody.trim()) {
    console.log(
      "[linear webhook] Prompted event has empty body, skipping follow-up",
      { agentSessionId },
    );
    return;
  }

  if (
    isLinearBootstrapPromptDuplicate({
      promptBody,
      issueIdentifier: meta.issueIdentifier,
    })
  ) {
    console.log(
      "[linear webhook] Prompted event contains initial Linear assignment, skipping duplicate",
      {
        agentSessionId,
        threadId: thread.id,
      },
    );
    return;
  }

  // Get full thread to find primary threadChat
  const threadFull = await getThread({
    db,
    threadId: thread.id,
    userId: thread.userId,
  });
  if (!threadFull) {
    console.warn("[linear webhook] Thread not found in getThread", {
      threadId: thread.id,
    });
    return;
  }

  let primaryChat: ReturnType<typeof getPrimaryThreadChat>;
  try {
    primaryChat = getPrimaryThreadChat(threadFull);
  } catch (err) {
    console.warn("[linear webhook] No thread chat found for thread", {
      threadId: thread.id,
      err,
    });
    return;
  }
  const threadChatId = primaryChat.id;

  // Linear pairs every `created` event with a redundant `prompted` event
  // carrying the same content in a different format. Skip the prompted side
  // when the thread is fresh and still on its first user message with no
  // agent output. The message-count + agent-activity guards carry dedup
  // correctness; the time bound is defense in depth.
  const createdAt =
    thread.createdAt instanceof Date
      ? thread.createdAt
      : thread.createdAt
        ? new Date(thread.createdAt)
        : null;
  const ageMs =
    createdAt !== null
      ? Date.now() - createdAt.getTime()
      : Number.POSITIVE_INFINITY;
  const transcript = primaryChat.messages ?? [];
  const userMessageCount = transcript.filter(
    (msg) => msg.type === "user",
  ).length;
  const hasAgentActivity = transcript.some((msg) => msg.type !== "user");
  if (
    ageMs < FRESH_THREAD_DEDUP_WINDOW_MS &&
    userMessageCount <= 1 &&
    !hasAgentActivity
  ) {
    console.log(
      "[linear webhook] Prompted event paired with create, skipping duplicate",
      {
        agentSessionId,
        threadId: thread.id,
        ageMs,
        userMessageCount,
      },
    );
    return;
  }

  const defaultModel = await getDefaultModel({ userId: thread.userId });

  console.log("[linear webhook] Queuing follow-up for prompted event", {
    agentSessionId,
    threadId: thread.id,
  });

  await queueFollowUpInternal({
    userId: thread.userId,
    threadId: thread.id,
    threadChatId,
    messages: [
      {
        type: "user",
        model: defaultModel,
        parts: [{ type: "text", text: promptBody }],
        timestamp: new Date().toISOString(),
      },
    ],
    appendOrReplace: "append",
    source: "www",
  });
}

async function handlePreThreadPrompted(
  payload: AgentSessionPromptedPayload,
  deliveryId: string | undefined,
  opts?: { createClient?: LinearClientFactory },
): Promise<void> {
  const { organizationId } = payload;
  const agentSessionId = payload.agentSession.id;
  const promptBody =
    payload.agentActivity?.content?.body ?? payload.promptContext ?? "";
  const selectedRepoFullName = parseGithubRepoFullName(promptBody);

  if (!selectedRepoFullName) {
    console.warn(
      "[linear webhook] No thread found for prompted event and prompt is not a repository selection",
      { agentSessionId },
    );
    return;
  }

  const installation = await getLinearInstallationForOrg({
    db,
    organizationId,
  });
  if (!installation || !installation.isActive) {
    console.warn(
      "[linear webhook] No active installation for pre-thread prompted event",
      { organizationId, agentSessionId },
    );
    return;
  }

  const tokenResult = await refreshLinearTokenIfNeeded(organizationId, db);
  if (tokenResult.status !== "ok") {
    console.warn("[linear webhook] Token unavailable for pre-thread prompt", {
      organizationId,
      status: tokenResult.status,
    });
    return;
  }

  await createLinearIssueThread({
    organizationId,
    agentSession: payload.agentSession,
    promptContext: payload.promptContext ?? null,
    deliveryId,
    accessToken: tokenResult.accessToken,
    appUserId: installation.appUserId,
    selectedRepoFullName,
    createClient: opts?.createClient,
  });
}

/**
 * Handle AppUserNotification webhooks.
 * Processes notification types that are relevant to the agent lifecycle.
 */
export async function handleAppUserNotification(
  payload: AppUserNotificationPayload,
): Promise<void> {
  const { organizationId } = payload;
  const notificationType = payload.notification?.type ?? "unknown";
  const linearUserId = payload.notification?.user?.id;
  const issueId = payload.notification?.issue?.id;

  console.log("[linear] AppUserNotification", {
    organizationId,
    notificationType,
    userId: linearUserId,
    issueId,
  });

  // Key notification types the agent should react to:
  // - issueUnassignedFromYou: agent was removed as delegate — log for visibility
  // - issueStatusChanged: issue status changed — may indicate user resolved externally
  // - issueEmojiReaction: user reacted to agent comment — could track satisfaction

  switch (notificationType) {
    case "issueUnassignedFromYou":
      console.log(
        "[linear] Agent was unassigned from issue — user may have resolved externally",
        { organizationId, issueId },
      );
      break;
    case "issueStatusChanged":
      console.log("[linear] Issue status changed externally", {
        organizationId,
        issueId,
      });
      break;
    default:
      // Other notification types are logged above — no action needed
      break;
  }
}

/**
 * Handle PermissionChange webhooks.
 * Tracks team access changes for the agent workspace installation.
 */
export async function handlePermissionChange(
  payload: PermissionChangePayload,
): Promise<void> {
  const { organizationId, addedTeamIds, removedTeamIds } = payload;

  console.log("[linear] PermissionChange", {
    organizationId,
    addedTeamIds,
    removedTeamIds,
    canAccessAllPublicTeams: payload.canAccessAllPublicTeams,
  });

  if (removedTeamIds.length > 0) {
    // Log warning — active threads in removed teams may be affected
    console.warn(
      "[linear] Agent lost access to teams — active threads may be impacted",
      { organizationId, removedTeamIds },
    );
  }
}

/**
 * Handle OAuthApp revoked webhook.
 * Deactivates the linearInstallation for the organization.
 * Uses CAS guard to avoid clobbering a concurrent reinstall.
 */
export async function handleOAuthAppRevoked(
  payload: OAuthAppRevokedPayload,
): Promise<void> {
  const { organizationId } = payload;

  console.log("[linear webhook] OAuthApp revoked — deactivating installation", {
    organizationId,
  });

  try {
    const { deactivateLinearInstallation, getLinearInstallationForOrg } =
      await import("@terragon/shared/model/linear");
    const installation = await getLinearInstallationForOrg({
      db,
      organizationId,
    });
    if (!installation) {
      return;
    }
    await deactivateLinearInstallation({
      db,
      organizationId,
      ifAccessTokenEncrypted: installation.accessTokenEncrypted,
    });
  } catch (error) {
    console.error(
      "[linear webhook] Failed to deactivate installation on OAuthApp revoked",
      { organizationId, error },
    );
  }
}
