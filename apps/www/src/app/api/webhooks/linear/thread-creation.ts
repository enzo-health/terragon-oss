import {
  AgentActivitySignal,
  LinearClient,
  type RepositorySuggestionsPayload,
} from "@linear/sdk";
import { publicAppUrl } from "@terragon/env/next-public";
import type { LinearMentionSourceMetadataInsert } from "@terragon/shared/db/types";
import { getEnvironments } from "@terragon/shared/model/environments";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import {
  claimLinearWebhookDelivery,
  completeLinearWebhookDelivery,
  getLinearAccountForLinearUserId,
  getLinearSettingsForUserAndOrg,
} from "@terragon/shared/model/linear";
import { getThreadByLinearDeliveryId } from "@terragon/shared/model/threads";
import { db } from "@/lib/db";
import { getDefaultModel } from "@/server-lib/default-ai-model";
import {
  type AgentSessionExternalUrlInput,
  emitAgentActivity,
  type LinearClientFactory,
  updateAgentSession,
} from "@/server-lib/linear-agent-activity";
import { newThreadInternal } from "@/server-lib/new-thread-internal";

export interface LinearAgentSessionForThreadCreation {
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

export const LINEAR_ASSIGNMENT_PROMPT_PREFIX =
  "You were assigned a Linear issue";
export const LINEAR_ASSIGNMENT_PROMPT_FOOTER =
  "Please work on this task. Your work will be sent to the user once you're done.";

const GITHUB_REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function formatLinearAssignmentPromptHeading({
  issueIdentifier,
  issueTitle,
}: {
  issueIdentifier: string;
  issueTitle: string;
}): string {
  return `${LINEAR_ASSIGNMENT_PROMPT_PREFIX} ${issueIdentifier}: ${issueTitle}`;
}

export function parseGithubRepoFullName(value: string): string | null {
  const trimmed = value.trim();
  if (GITHUB_REPO_FULL_NAME_PATTERN.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com") {
      return null;
    }
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo) {
      return null;
    }
    const fullName = `${owner}/${repo}`;
    return GITHUB_REPO_FULL_NAME_PATTERN.test(fullName) ? fullName : null;
  } catch {
    return null;
  }
}

export async function createLinearIssueThread({
  organizationId,
  agentSession,
  promptContext,
  deliveryId,
  accessToken,
  appUserId,
  selectedRepoFullName,
  createClient,
}: {
  organizationId: string;
  agentSession: LinearAgentSessionForThreadCreation;
  promptContext?: string | null;
  deliveryId?: string;
  accessToken: string;
  appUserId?: string | null;
  selectedRepoFullName?: string;
  createClient?: LinearClientFactory;
}): Promise<void> {
  if (deliveryId) {
    const existingThread = await getThreadByLinearDeliveryId({
      db,
      deliveryId,
    });
    if (existingThread) {
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
    organizationId,
    agentSession,
    promptContext,
    deliveryId,
    accessToken,
    appUserId,
    selectedRepoFullName,
    createClient,
  });
}

async function createThreadRecord({
  organizationId,
  agentSession,
  promptContext,
  deliveryId,
  accessToken,
  appUserId,
  selectedRepoFullName,
  createClient,
}: {
  organizationId: string;
  agentSession: LinearAgentSessionForThreadCreation;
  promptContext?: string | null;
  deliveryId?: string;
  accessToken: string;
  appUserId?: string | null;
  selectedRepoFullName?: string;
  createClient?: LinearClientFactory;
}): Promise<void> {
  const issue = agentSession.issue;
  const issueId = agentSession.issueId ?? issue?.id;
  const issueIdentifier = issue?.identifier ?? "";
  const issueTitle = issue?.title ?? "Untitled Issue";
  const issueUrl = issue?.url ?? "";

  if (!issueId) {
    console.error("[linear webhook] No issueId in agentSession, skipping", {
      agentSessionId: agentSession.id,
    });
    return;
  }

  const actorId = agentSession.creatorId;
  if (!actorId) {
    console.error("[linear webhook] No creatorId in agentSession, skipping", {
      agentSessionId: agentSession.id,
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

  const linearSettings = await getLinearSettingsForUserAndOrg({
    db,
    userId,
    organizationId,
  });

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

  let githubRepoFullName: string | null = selectedRepoFullName ?? null;
  let shouldEmitSelectSignal = false;
  let selectOptions: Array<{ label: string; value: string }> = [];
  if (!githubRepoFullName && candidateRepoNames.size > 0) {
    try {
      const candidateRepositories = [...candidateRepoNames].map(
        (repositoryFullName) => ({
          repositoryFullName,
          hostname: "github.com",
        }),
      );
      const clientFactory =
        createClient ??
        ((token: string) => new LinearClient({ accessToken: token }));
      const client = clientFactory(accessToken);
      const suggestionsPayload: RepositorySuggestionsPayload =
        await client.issueRepositorySuggestions(
          candidateRepositories,
          issueId,
          { agentSessionId: agentSession.id },
        );
      const suggestions = suggestionsPayload.suggestions ?? [];
      if (suggestions.length > 0) {
        const best = suggestions.reduce((a, b) =>
          b.confidence > a.confidence ? b : a,
        );
        if (best.confidence >= 0.7) {
          githubRepoFullName = best.repositoryFullName;
        } else if (suggestions.length > 1 && !defaultRepo) {
          shouldEmitSelectSignal = true;
          selectOptions = suggestions.map((suggestion) => ({
            label: suggestion.repositoryFullName,
            value: suggestion.repositoryFullName,
          }));
        } else {
          githubRepoFullName = defaultRepo ?? best.repositoryFullName;
        }
      }
    } catch (err) {
      console.warn(
        "[linear webhook] issueRepositorySuggestions failed, falling back",
        {
          agentSessionId: agentSession.id,
          err,
        },
      );
    }
  }

  if (!githubRepoFullName) {
    githubRepoFullName = defaultRepo ?? null;
  }

  if (!githubRepoFullName) {
    if (shouldEmitSelectSignal && selectOptions.length > 0) {
      await emitAgentActivity({
        agentSessionId: agentSession.id,
        accessToken,
        content: {
          type: "elicitation",
          body: "Which repository should I work on for this issue?",
        },
        signal: AgentActivitySignal.Select,
        signalMetadata: { options: selectOptions },
        createClient,
      });
      console.log("[linear webhook] Emitted select signal for repo choice", {
        agentSessionId: agentSession.id,
        optionCount: selectOptions.length,
      });
      return;
    }

    await emitAgentActivity({
      agentSessionId: agentSession.id,
      accessToken,
      content: {
        type: "elicitation",
        body: "I couldn't determine which repository to work on. Please configure a default repository in your Terragon Linear settings and try again.",
      },
      createClient,
    });
    console.error(
      "[linear webhook] No GitHub repo for user, emitted elicitation",
      {
        userId,
      },
    );
    return;
  }

  const defaultModel = linearSettings?.defaultModel
    ? linearSettings.defaultModel
    : await getDefaultModel({ userId });

  const messageParts: string[] = [];
  messageParts.push(
    formatLinearAssignmentPromptHeading({ issueIdentifier, issueTitle }),
  );
  if (promptContext) {
    messageParts.push(`**Context from Linear:**\n${promptContext}`);
  }
  messageParts.push(LINEAR_ASSIGNMENT_PROMPT_FOOTER);
  if (issueUrl) {
    messageParts.push(issueUrl);
  }
  const formattedMessage = messageParts.join("\n\n");

  console.log("[linear webhook] Creating thread for user", {
    userId,
    agentSessionId: agentSession.id,
  });

  const sourceMetadata: LinearMentionSourceMetadataInsert = {
    type: "linear-mention",
    organizationId,
    issueId,
    issueIdentifier,
    issueUrl,
    agentSessionId: agentSession.id,
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

  const externalUrls: AgentSessionExternalUrlInput[] = [
    { label: "Terragon Task", url: taskUrl },
  ];
  await updateAgentSession({
    sessionId: agentSession.id,
    accessToken,
    externalUrls,
    createClient,
  });

  await Promise.all([
    transitionIssueToStarted({
      accessToken,
      issueId,
      createClient,
    }),
    setAgentAsDelegate({
      accessToken,
      issueId,
      appUserId,
      createClient,
    }),
  ]);

  if (deliveryId) {
    await completeLinearWebhookDelivery({
      db,
      deliveryId,
      threadId,
    });
  }
}

async function transitionIssueToStarted({
  accessToken,
  issueId,
  createClient = (token: string) => new LinearClient({ accessToken: token }),
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

    const firstStarted = startedStates.reduce((a, b) =>
      (b.position ?? Infinity) < (a.position ?? Infinity) ? b : a,
    );

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

async function setAgentAsDelegate({
  accessToken,
  issueId,
  appUserId,
  createClient = (token: string) => new LinearClient({ accessToken: token }),
}: {
  accessToken: string;
  issueId: string;
  appUserId?: string | null;
  createClient?: LinearClientFactory;
}): Promise<void> {
  try {
    const client = createClient(accessToken);
    const issue = await client.issue(issueId);
    if (!issue) return;

    const currentDelegate = await issue.delegate;
    if (currentDelegate) return;

    const delegateId = appUserId ?? (await client.viewer).id;
    await client.updateIssue(issueId, { delegateId });
    console.log("[linear webhook] Set agent as delegate on issue", {
      issueId,
      delegateId,
    });
  } catch (error) {
    console.warn("[linear webhook] Failed to set agent as delegate", {
      issueId,
      error,
    });
  }
}
