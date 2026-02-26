import { db } from "@/lib/db";
import { publicAppUrl } from "@terragon/env/next-public";
import {
  getLinearAccountForLinearUserId,
  getLinearSettingsForUserAndOrg,
  getLinearInstallationForOrg,
  claimLinearWebhookDelivery,
  completeLinearWebhookDelivery,
} from "@terragon/shared/model/linear";
import {
  getThreadByLinearAgentSessionId,
  getThreadByLinearDeliveryId,
  getThread,
} from "@terragon/shared/model/threads";
import { getPrimaryThreadChat } from "@terragon/shared/utils/thread-utils";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { getAccessInfoForUser } from "@/lib/subscription";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { getDefaultModel } from "@/server-lib/default-ai-model";
import { refreshLinearTokenIfNeeded } from "@/server-lib/linear-oauth";
import {
  emitAgentActivity,
  updateAgentSession,
  type LinearClientFactory,
  type AgentSessionExternalUrlInput,
} from "@/server-lib/linear-agent-activity";
import { getEnvironments } from "@terragon/shared/model/environments";
import { LinearClient, type RepositorySuggestionsPayload } from "@linear/sdk"; // Used in inline factory for issueRepositorySuggestions
import { decryptValue } from "@terragon/utils/encryption";
import { env } from "@terragon/env/apps-www";

// ---------------------------------------------------------------------------
// Webhook payload types
// ---------------------------------------------------------------------------

interface AgentSessionCreatedPayload {
  type: "AgentSessionEvent";
  action: "created";
  organizationId: string;
  data: {
    id: string;
    agentSession: {
      id: string;
      promptContext?: {
        issueId?: string;
        issueIdentifier?: string;
        issueTitle?: string;
        issueDescription?: string;
        issueUrl?: string;
        actorId?: string;
      };
      actorId?: string;
    };
  };
}

interface AgentSessionPromptedPayload {
  type: "AgentSessionEvent";
  action: "prompted";
  organizationId: string;
  data: {
    id: string;
    agentActivity?: {
      body?: string;
    };
  };
}

type AgentSessionEventPayload =
  | AgentSessionCreatedPayload
  | AgentSessionPromptedPayload
  | {
      type: "AgentSessionEvent";
      action: string;
      organizationId: string;
      data: { id: string };
    };

interface AppUserNotificationPayload {
  type: "AppUserNotification";
  organizationId: string;
  notification?: {
    type?: string;
    user?: { id?: string };
    issue?: { id?: string };
  };
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
    }).then(() => {
      if (!done) {
        done = true;
        clearTimeout(timer);
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
  const agentSessionId = payload.data.id;

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
  const agentSessionId = payload.data.agentSession.id;

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
  const promptContext = payload.data.agentSession.promptContext;
  const preflightIssueId = promptContext?.issueId;
  const preflightActorId =
    payload.data.agentSession.actorId ??
    payload.data.agentSession.promptContext?.actorId;

  if (!preflightIssueId) {
    console.error(
      "[linear webhook] Pre-flight: no issueId in agentSession promptContext, skipping",
      { agentSessionId },
    );
    return;
  }
  if (!preflightActorId) {
    console.error(
      "[linear webhook] Pre-flight: no actorId in agentSession, skipping",
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
      createClient: opts?.createClient,
    }).then(() => {
      if (!done) {
        done = true;
        clearTimeout(timer);
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
  const promptContext = payload.data.agentSession.promptContext;
  const issueId = promptContext?.issueId;
  const issueIdentifier = promptContext?.issueIdentifier ?? "";
  const issueTitle = promptContext?.issueTitle ?? "Untitled Issue";
  const issueUrl = promptContext?.issueUrl ?? "";

  if (!issueId) {
    console.error(
      "[linear webhook] No issueId in agentSession promptContext, skipping",
      {
        agentSessionId,
      },
    );
    return;
  }

  // Resolve user from agentSession.actorId → linearAccount.linearUserId → Terragon userId
  const actorId =
    payload.data.agentSession.actorId ??
    payload.data.agentSession.promptContext?.actorId;

  if (!actorId) {
    console.error("[linear webhook] No actorId in agentSession, skipping", {
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

  // Check user access tier
  const accessInfo = await getAccessInfoForUser(userId);
  if (accessInfo.tier === "none") {
    console.log("[linear webhook] User has no access tier", { userId });
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

  // issueRepositorySuggestions — pick highest confidence
  let githubRepoFullName: string | null = null;
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
        githubRepoFullName = best.repositoryFullName;
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
    console.error("[linear webhook] No GitHub repo for user, skipping", {
      userId,
    });
    return;
  }

  // Determine model
  const defaultModel = linearSettings?.defaultModel
    ? linearSettings.defaultModel
    : await getDefaultModel({ userId });

  // Build message
  const messageParts: string[] = [];
  messageParts.push(
    `You were assigned a Linear issue ${issueIdentifier}: ${issueTitle}`,
  );
  if (promptContext?.issueDescription) {
    messageParts.push(
      `**Issue description:**\n${promptContext.issueDescription}`,
    );
  }
  messageParts.push(
    "Please work on this task. Your work will be sent to the user once you're done.",
  );
  if (issueUrl) {
    messageParts.push(issueUrl);
  }
  const formattedMessage = messageParts.join("\n\n");

  console.log("[linear webhook] Creating thread for user", {
    userId,
    agentSessionId,
  });

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
    sourceMetadata: {
      type: "linear-mention",
      organizationId,
      issueId,
      issueIdentifier,
      issueUrl,
      agentSessionId,
      ...(deliveryId ? { linearDeliveryId: deliveryId } : {}),
    },
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
  const agentSessionId = payload.data.id;

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
  const meta = thread.sourceMetadata as { agentSessionId?: string } | null;
  if (!meta?.agentSessionId) {
    console.log(
      "[linear webhook] Legacy thread without agentSessionId, skipping prompted event",
      { threadId: thread.id },
    );
    return;
  }

  const promptBody =
    (payload.data as AgentSessionPromptedPayload["data"]).agentActivity?.body ??
    "";

  // Skip empty prompts — no useful work to queue
  if (!promptBody.trim()) {
    console.log(
      "[linear webhook] Prompted event has empty body, skipping follow-up",
      { agentSessionId },
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

  let threadChatId: string;
  try {
    threadChatId = getPrimaryThreadChat(threadFull).id;
  } catch (err) {
    console.warn("[linear webhook] No thread chat found for thread", {
      threadId: thread.id,
      err,
    });
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
 * These are logged only — no thread creation (they lack agentSessionId).
 */
export async function handleAppUserNotification(
  payload: AppUserNotificationPayload,
): Promise<void> {
  const { organizationId } = payload;
  const notificationType = payload.notification?.type ?? "unknown";
  const linearUserId = payload.notification?.user?.id;

  console.log("[linear] AppUserNotification", {
    organizationId,
    notificationType,
    userId: linearUserId,
  });
  // Log only — do NOT create threads (AppUserNotification lacks agentSessionId)
}
