import {
  LinearClient,
  AgentActivitySignal,
  type RepositorySuggestionsPayload,
} from "@linear/sdk"; // Used in inline factory for issueRepositorySuggestions
import { env } from "@terragon/env/apps-www";
import { publicAppUrl } from "@terragon/env/next-public";
import type { LinearMentionSourceMetadataInsert } from "@terragon/shared/db/types";
import { getEnvironments } from "@terragon/shared/model/environments";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import {
  claimLinearWebhookDelivery,
  completeLinearWebhookDelivery,
  getLinearAccountForLinearUserId,
  getLinearInstallationForOrg,
  getLinearSettingsForUserAndOrg,
} from "@terragon/shared/model/linear";
import {
  getThread,
  getThreadByLinearAgentSessionId,
  getThreadByLinearDeliveryId,
} from "@terragon/shared/model/threads";
import { getPrimaryThreadChat } from "@terragon/shared/utils/thread-utils";
import { decryptValue } from "@terragon/utils/encryption";
import { db } from "@/lib/db";
import { getDefaultModel } from "@/server-lib/default-ai-model";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import {
  type AgentSessionExternalUrlInput,
  emitAgentActivity,
  type LinearClientFactory,
  updateAgentSession,
} from "@/server-lib/linear-agent-activity";
import { refreshLinearTokenIfNeeded } from "@/server-lib/linear-oauth";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { stopThread } from "@/server-lib/stop-thread";

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
const LINEAR_ASSIGNMENT_PROMPT_PREFIX = "You were assigned a Linear issue";
const LINEAR_ASSIGNMENT_PROMPT_FOOTER =
  "Please work on this task. Your work will be sent to the user once you're done.";

function formatLinearAssignmentPromptHeading({
  issueIdentifier,
  issueTitle,
}: {
  issueIdentifier: string;
  issueTitle: string;
}): string {
  return `${LINEAR_ASSIGNMENT_PROMPT_PREFIX} ${issueIdentifier}: ${issueTitle}`;
}

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
// Issue lifecycle helpers (best practices from Linear Agent Interaction docs)
// ---------------------------------------------------------------------------

/**
 * Transition the issue to the first "started" workflow state when the agent
 * begins work. Per Linear best practices: "If your agent is delegated to work
 * on an issue that is not in a started/completed/canceled status type, move
 * the issue to the first status in started."
 *
 * Best-effort — errors are logged but never block thread creation.
 */
async function transitionIssueToStarted({
  accessToken,
  issueId,
  createClient = (t: string) => new LinearClient({ accessToken: t }),
}: {
  accessToken: string;
  issueId: string;
  createClient?: LinearClientFactory;
}): Promise<void> {
  try {
    const client = createClient(accessToken);
    const issue = await client.issue(issueId);
    if (!issue) return;

    const team = await issue.team;
    if (!team) return;

    const states = await team.states({
      filter: { type: { eq: "started" } },
    });
    const startedStates = states.nodes;
    if (startedStates.length === 0) return;

    // Pick the one with lowest position (first "started" column)
    const firstStarted = startedStates.reduce((a, b) =>
      (b.position ?? Infinity) < (a.position ?? Infinity) ? b : a,
    );

    // Only transition if the current state is not already started/completed/canceled
    const currentState = await issue.state;
    if (!currentState) return;
    const currentType = currentState.type as string;
    if (
      currentType === "started" ||
      currentType === "completed" ||
      currentType === "canceled"
    ) {
      return;
    }

    await client.updateIssue(issueId, { stateId: firstStarted.id });
    console.log("[linear webhook] Transitioned issue to started state", {
      issueId,
      stateName: firstStarted.name,
    });
  } catch (error) {
    console.warn("[linear webhook] Failed to transition issue to started", {
      issueId,
      error,
    });
  }
}

/**
 * Set the agent as the delegate on the issue. Per Linear best practices:
 * "If your agent is working on implementation and no Issue.delegate is currently
 * set, it should set itself as the delegate."
 *
 * Best-effort — errors are logged but never block thread creation.
 */
async function setAgentAsDelegate({
  accessToken,
  issueId,
  createClient = (t: string) => new LinearClient({ accessToken: t }),
}: {
  accessToken: string;
  issueId: string;
  createClient?: LinearClientFactory;
}): Promise<void> {
  try {
    const client = createClient(accessToken);
    const issue = await client.issue(issueId);
    if (!issue) return;

    // Only set delegate if none is currently assigned
    const currentDelegate = await issue.delegate;
    if (currentDelegate) return;

    // The app user ID is available via the viewer query
    const viewer = await client.viewer;
    await client.updateIssue(issueId, { delegateId: viewer.id });
    console.log("[linear webhook] Set agent as delegate on issue", {
      issueId,
      delegateId: viewer.id,
    });
  } catch (error) {
    console.warn("[linear webhook] Failed to set agent as delegate", {
      issueId,
      error,
    });
  }
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

  // 5-7. Create thread in-band so failures surface to the webhook response path
  // and can be retried by Linear delivery retries.
  await createThreadForAgentSession({
    payload,
    deliveryId,
    accessToken,
    organizationId,
    agentSessionId,
    opts,
  });
}

async function createThreadForAgentSession({
  payload,
  deliveryId,
  accessToken,
  organizationId,
  agentSessionId,
  opts,
}: {
  payload: AgentSessionCreatedPayload;
  deliveryId: string | undefined;
  accessToken: string;
  organizationId: string;
  agentSessionId: string;
  opts?: { createClient?: LinearClientFactory };
}): Promise<void> {
  if (deliveryId) {
    const existingThread = await getThreadByLinearDeliveryId({
      db,
      deliveryId,
    });
    if (existingThread) {
      // Recovery path: prior attempt created a thread but failed to persist
      // completion marker. Reconcile and skip duplicate thread creation.
      await completeLinearWebhookDelivery({
        db,
        deliveryId,
        threadId: existingThread.id,
      });
      console.log(
        "[linear webhook] Reconciled delivery using existing thread mapping",
        {
          deliveryId,
          threadId: existingThread.id,
        },
      );
      return;
    }
  }

  // 5. Idempotency: claim the Delivery-Id before creating a thread.
  // If the previous handler crashed mid-creation (completedAt=NULL), retries are allowed.
  // Only when completedAt IS NOT NULL (thread created successfully) do we skip.
  if (deliveryId) {
    const { claimed } = await claimLinearWebhookDelivery({ db, deliveryId });
    if (!claimed) {
      console.log(
        "[linear webhook] Idempotent: deliveryId already completed, skipping",
        { deliveryId },
      );
      return;
    }
  }

  await createThreadRecord({
    payload,
    deliveryId,
    accessToken,
    organizationId,
    agentSessionId,
    opts,
  });
}

/**
 * The core thread creation logic. Called after the idempotency claim succeeds
 * (or when deliveryId is absent and no claim is needed).
 */
async function createThreadRecord({
  payload,
  deliveryId,
  accessToken,
  organizationId,
  agentSessionId,
  opts,
}: {
  payload: AgentSessionCreatedPayload;
  deliveryId: string | undefined;
  accessToken: string;
  organizationId: string;
  agentSessionId: string;
  opts?: { createClient?: LinearClientFactory };
}): Promise<void> {
  const issue = payload.agentSession.issue;
  const issueId = payload.agentSession.issueId ?? issue?.id;
  const issueIdentifier = issue?.identifier ?? "";
  const issueTitle = issue?.title ?? "Untitled Issue";
  const issueUrl = issue?.url ?? "";

  if (!issueId) {
    console.error("[linear webhook] No issueId in agentSession, skipping", {
      agentSessionId,
    });
    return;
  }

  // Resolve user from agentSession.creatorId → linearAccount.linearUserId → Terragon userId
  const actorId = payload.agentSession.creatorId;

  if (!actorId) {
    console.error("[linear webhook] No creatorId in agentSession, skipping", {
      agentSessionId,
    });
    return;
  }

  const linearAccount = await getLinearAccountForLinearUserId({
    db,
    organizationId,
    linearUserId: actorId,
  });

  if (!linearAccount) {
    console.error("[linear webhook] No linked account for actor", {
      actorId,
      organizationId,
    });
    return;
  }

  const userId = linearAccount.userId;

  // Check feature flag
  const linearIntegrationEnabled = await getFeatureFlagForUser({
    db,
    userId,
    flagName: "linearIntegration",
  });
  if (!linearIntegrationEnabled) {
    console.log(
      "[linear webhook] linearIntegration feature flag disabled for user",
      { userId },
    );
    return;
  }

  // Get Linear settings for default repo and model
  const linearSettings = await getLinearSettingsForUserAndOrg({
    db,
    userId,
    organizationId,
  });

  // Determine candidate repos for issueRepositorySuggestions
  const defaultRepo = linearSettings?.defaultRepoFullName;
  const userEnvironments = await getEnvironments({
    db,
    userId,
    includeGlobal: false,
  });
  const candidateRepoNames = new Set<string>();
  if (defaultRepo) candidateRepoNames.add(defaultRepo);
  for (const localEnv of userEnvironments) {
    if (localEnv.repoFullName && candidateRepoNames.size < 10) {
      candidateRepoNames.add(localEnv.repoFullName);
    }
  }

  // issueRepositorySuggestions — pick highest confidence, or emit select signal
  // when multiple candidates exist but no clear winner
  let githubRepoFullName: string | null = null;
  let shouldEmitSelectSignal = false;
  let selectOptions: Array<{ label: string; value: string }> = [];
  if (candidateRepoNames.size > 0) {
    try {
      const candidateRepositories = [...candidateRepoNames].map(
        (repositoryFullName) => ({
          repositoryFullName,
          hostname: "github.com",
        }),
      );
      const createClient =
        opts?.createClient ??
        ((t: string) => new LinearClient({ accessToken: t }));
      const client = createClient(accessToken);
      const suggestionsPayload: RepositorySuggestionsPayload =
        await client.issueRepositorySuggestions(
          candidateRepositories,
          issueId,
          { agentSessionId },
        );
      const suggestions = suggestionsPayload.suggestions ?? [];
      if (suggestions.length > 0) {
        const best = suggestions.reduce((a, b) =>
          b.confidence > a.confidence ? b : a,
        );
        // If top suggestion has high confidence, use it directly
        if (best.confidence >= 0.7) {
          githubRepoFullName = best.repositoryFullName;
        } else if (suggestions.length > 1 && !defaultRepo) {
          // No default repo and low confidence — ask user via select signal
          shouldEmitSelectSignal = true;
          selectOptions = suggestions.map((s) => ({
            label: s.repositoryFullName,
            value: s.repositoryFullName,
          }));
        } else {
          // Low confidence but have a default — use default as fallback
          githubRepoFullName = best.repositoryFullName;
        }
      }
    } catch (err) {
      console.warn(
        "[linear webhook] issueRepositorySuggestions failed, falling back",
        {
          agentSessionId,
          err,
        },
      );
    }
  }

  // Fall back to defaultRepoFullName
  if (!githubRepoFullName) {
    githubRepoFullName = defaultRepo ?? null;
  }

  if (!githubRepoFullName) {
    if (shouldEmitSelectSignal && selectOptions.length > 0) {
      // Multiple repos with low confidence — ask user to pick
      await emitAgentActivity({
        agentSessionId,
        accessToken,
        content: {
          type: "elicitation",
          body: "Which repository should I work on for this issue?",
        },
        signal: AgentActivitySignal.Select,
        signalMetadata: { options: selectOptions },
        createClient: opts?.createClient,
      });
      console.log("[linear webhook] Emitted select signal for repo choice", {
        agentSessionId,
        optionCount: selectOptions.length,
      });
      // Do NOT mark the delivery as completed — the session is awaiting input,
      // and when the user responds via a prompted event, the handler will need
      // to create a thread. Leaving deliveryId un-completed allows Linear retries
      // if the session times out without a response.
      return;
    }
    // No repos at all and no default — emit elicitation asking user to configure
    await emitAgentActivity({
      agentSessionId,
      accessToken,
      content: {
        type: "elicitation",
        body: "I couldn't determine which repository to work on. Please configure a default repository in your Terragon Linear settings and try again.",
      },
      createClient: opts?.createClient,
    });
    console.error(
      "[linear webhook] No GitHub repo for user, emitted elicitation",
      {
        userId,
      },
    );
    return;
  }

  // Determine model
  const defaultModel = linearSettings?.defaultModel
    ? linearSettings.defaultModel
    : await getDefaultModel({ userId });

  // Build message — use Linear's promptContext (formatted string with issue
  // details, comments, and guidance) when available, falling back to basic info.
  const messageParts: string[] = [];
  messageParts.push(
    formatLinearAssignmentPromptHeading({ issueIdentifier, issueTitle }),
  );
  if (payload.promptContext) {
    messageParts.push(`**Context from Linear:**\n${payload.promptContext}`);
  }
  messageParts.push(LINEAR_ASSIGNMENT_PROMPT_FOOTER);
  if (issueUrl) {
    messageParts.push(issueUrl);
  }
  const formattedMessage = messageParts.join("\n\n");

  console.log("[linear webhook] Creating thread for user", {
    userId,
    agentSessionId,
  });

  const sourceMetadata: LinearMentionSourceMetadataInsert = {
    type: "linear-mention",
    organizationId,
    issueId,
    issueIdentifier,
    issueUrl,
    agentSessionId,
    ...(deliveryId ? { linearDeliveryId: deliveryId } : {}),
  };

  const { threadId } = await newThreadInternal({
    userId,
    message: {
      type: "user",
      model: defaultModel,
      parts: [{ type: "text", text: formattedMessage }],
      timestamp: new Date().toISOString(),
    },
    githubRepoFullName,
    baseBranchName: null,
    headBranchName: null,
    sourceType: "linear-mention",
    sourceMetadata,
  });

  const taskUrl = `${publicAppUrl()}/task/${threadId}`;
  console.log("[linear webhook] Created thread", { threadId, taskUrl });

  // Update agent session with external URL (typed as { label, url } per Linear SDK)
  const externalUrls: AgentSessionExternalUrlInput[] = [
    { label: "Terragon Task", url: taskUrl },
  ];
  await updateAgentSession({
    sessionId: agentSessionId,
    accessToken,
    externalUrls,
    createClient: opts?.createClient,
  });

  // Best-effort: transition issue to "started" status and set agent as delegate.
  // These follow Linear's Agent Interaction best practices. Errors are logged
  // but never block the already-successful thread creation path.
  await Promise.all([
    transitionIssueToStarted({
      accessToken,
      issueId,
      createClient: opts?.createClient,
    }),
    setAgentAsDelegate({
      accessToken,
      issueId,
      createClient: opts?.createClient,
    }),
  ]);

  // Mark delivery as completed — retries will now skip via completedAt IS NOT NULL.
  if (deliveryId) {
    await completeLinearWebhookDelivery({
      db,
      deliveryId,
      threadId,
    });
  }
}

async function handleAgentSessionPrompted(
  payload: AgentSessionPromptedPayload,
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
    console.warn(
      "[linear webhook] No thread found for agentSessionId on prompted event",
      { agentSessionId },
    );
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
