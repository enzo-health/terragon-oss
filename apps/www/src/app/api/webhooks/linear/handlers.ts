import { db } from "@/lib/db";
import { publicAppUrl } from "@terragon/env/next-public";
import {
  getLinearAccountForLinearUserId,
  getLinearSettingsForUserAndOrg,
  getLinearInstallationForOrg,
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
import { waitUntil } from "@vercel/functions";
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

/** Simple timeout promise that rejects after `ms` milliseconds. */
function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
  );
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

  // 2. Token refresh with 2.5s hard budget
  let accessToken: string;
  try {
    const result = await Promise.race([
      refreshLinearTokenIfNeeded(organizationId, db),
      timeout(2500),
    ]);
    if (result.status !== "ok") {
      // Reinstall required — emit error activity using the installation's
      // existing (possibly stale) token as best-effort, then return.
      console.error("[linear webhook] Token refresh: reinstall required", {
        organizationId,
      });
      const fallbackToken = decryptValue(
        installation.accessTokenEncrypted,
        env.ENCRYPTION_MASTER_KEY,
      );
      await emitAgentActivity({
        agentSessionId,
        accessToken: fallbackToken,
        content: {
          type: "error",
          body: "Authentication failure — please reinstall the Linear Agent",
        },
        createClient: opts?.createClient,
      });
      return;
    }
    accessToken = result.accessToken;
  } catch (err) {
    // Timeout or other error — log, skip thread creation, return 200.
    // We have no valid token to emit an error activity with.
    console.error(
      "[linear webhook] Token refresh timed out or failed, returning 200",
      { agentSessionId, err },
    );
    return;
  }

  // 3. Synchronously emit `thought` activity BEFORE returning HTTP 200 (<10s SLA).
  // emitAgentActivity catches all errors internally, so this call never throws.
  // We race against a 3s timeout to guard the remaining webhook budget.
  await Promise.race([
    emitAgentActivity({
      agentSessionId,
      accessToken,
      content: {
        type: "thought",
        body: "Starting work on this issue...",
      },
      createClient: opts?.createClient,
    }),
    timeout(3000).catch(() => {
      console.error(
        "[linear webhook] Thought emission timed out (SLA guard), continuing",
        { agentSessionId },
      );
    }),
  ]);

  // 5-7. Async thread creation via waitUntil
  waitUntil(
    createThreadForAgentSession({
      payload,
      deliveryId,
      accessToken,
      organizationId,
      agentSessionId,
      opts,
    }).catch((err) => {
      console.error("[linear webhook] Error in async thread creation", {
        agentSessionId,
        err,
      });
    }),
  );
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
  // 5. Idempotency check: skip if thread already exists with this deliveryId
  if (deliveryId) {
    const existing = await getThreadByLinearDeliveryId({ db, deliveryId });
    if (existing) {
      console.log(
        "[linear webhook] Idempotent: thread already exists for deliveryId, skipping",
        { deliveryId, threadId: existing.id },
      );
      return;
    }
  }

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
  for (const env of userEnvironments) {
    if (env.repoFullName && candidateRepoNames.size < 10) {
      candidateRepoNames.add(env.repoFullName);
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
