/**
 * Linear Agent activity emission helpers.
 *
 * Uses `LinearClient.createAgentActivity()` from @linear/sdk (typed SDK — no raw GraphQL).
 * Activity content shapes per Linear Agent Interaction docs:
 *   - thought:    { type: "thought", body: string }
 *   - elicitation: { type: "elicitation", body: string }
 *   - action:     { type: "action", action: string, parameter: string, result?: string }
 *   - response:   { type: "response", body: string }
 *   - error:      { type: "error", body: string }
 *
 * Signals (optional metadata on activities):
 *   - auth:   agent needs user to complete account linking
 *   - select: agent presents options for user to choose from
 *
 * Ephemeral activities: thought/action types can be marked ephemeral (temporary, replaced by next activity).
 */

import { LinearClient, AgentActivitySignal } from "@linear/sdk";
import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import type { ThreadSourceMetadata } from "@terragon/shared/db/types";
import { deriveDBMessagesFromCanonical } from "@terragon/shared/model/derive-db-messages-from-canonical";
import { db } from "@/lib/db";
import { refreshLinearTokenIfNeeded } from "@/server-lib/linear-oauth";
import {
  extractLastAssistantTextFromDBMessages,
  extractLatestAgentPlanFromDBMessages,
} from "@/server-lib/linear-activity-from-canonical";

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
  | { type: "elicitation"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

/** Signal types that modify how an agent activity should be interpreted. */
export type AgentActivitySignalType = `${AgentActivitySignal}`;

/** Metadata for the `auth` signal — provides account linking URL. */
export type AuthSignalMetadata = {
  url: string;
  providerName?: string;
  userId?: string;
};

/** Metadata for the `select` signal — provides options for user to choose. */
export type SelectSignalMetadata = {
  options: Array<{ label: string; value: string }>;
};

export type AgentActivitySignalMetadata =
  | AuthSignalMetadata
  | SelectSignalMetadata;

/**
 * Emit a Linear agent activity for a session.
 *
 * All errors are caught and logged — never throws.
 *
 * @param opts.agentSessionId - Linear agent session ID
 * @param opts.accessToken - OAuth access token for the workspace installation
 * @param opts.content - Activity content (typed per Linear API shapes)
 * @param opts.ephemeral - If true, activity is temporary and replaced by the next one (thought/action only)
 * @param opts.signal - Optional signal type (auth, select) to modify how the activity is interpreted
 * @param opts.signalMetadata - Optional metadata for the signal (e.g. URL for auth, options for select)
 * @param opts.createClient - Injectable factory for testability (defaults to real LinearClient)
 */
export async function emitAgentActivity({
  agentSessionId,
  accessToken,
  content,
  ephemeral,
  signal,
  signalMetadata,
  createClient = defaultClientFactory,
}: {
  agentSessionId: string;
  accessToken: string;
  content: AgentActivityContent;
  ephemeral?: boolean;
  signal?: AgentActivitySignal;
  signalMetadata?: AgentActivitySignalMetadata;
  createClient?: LinearClientFactory;
}): Promise<void> {
  try {
    const client = createClient(accessToken);
    await client.createAgentActivity({
      agentSessionId,
      content,
      ...(ephemeral ? { ephemeral } : {}),
      ...(signal ? { signal } : {}),
      ...(signalMetadata ? { signalMetadata } : {}),
    });
  } catch (error) {
    console.error("[linear-agent-activity] Failed to emit activity", {
      agentSessionId,
      contentType: content.type,
      ephemeral,
      signal,
      error,
    });
  }
}

/** Plan step status values per Linear Agent Plans API. */
export type AgentPlanStepStatus =
  | "pending"
  | "inProgress"
  | "completed"
  | "canceled";

/** A single step in an agent plan. */
export type AgentPlanStep = {
  content: string;
  status: AgentPlanStepStatus;
};

/** Narrow local shape for the Agent Session update fields we currently use. */
type LinearAgentSessionUpdateInput = {
  externalUrls?: AgentSessionExternalUrlInput[];
  addedExternalUrls?: AgentSessionExternalUrlInput[];
  plan?: AgentPlanStep[];
};

/**
 * Update the Linear agent session with external URLs (e.g. Terragon task URL).
 *
 * All errors are caught and logged — never throws.
 *
 * @param opts.sessionId - Linear agent session ID
 * @param opts.accessToken - OAuth access token for the workspace installation
 * @param opts.externalUrls - Array of { label, url } objects to set on the session
 * @param opts.addedExternalUrls - Array of { label, url } objects to add (without replacing existing)
 * @param opts.plan - Full array of plan steps (replaces entire plan)
 * @param opts.createClient - Injectable factory for testability
 */
export async function updateAgentSession({
  sessionId,
  accessToken,
  externalUrls,
  addedExternalUrls,
  plan,
  createClient = defaultClientFactory,
}: {
  sessionId: string;
  accessToken: string;
  externalUrls?: AgentSessionExternalUrlInput[];
  addedExternalUrls?: AgentSessionExternalUrlInput[];
  plan?: AgentPlanStep[];
  createClient?: LinearClientFactory;
}): Promise<void> {
  try {
    const client = createClient(accessToken);
    const updateInput: LinearAgentSessionUpdateInput = {};
    if (externalUrls) {
      updateInput.externalUrls = externalUrls;
    }
    if (addedExternalUrls) {
      updateInput.addedExternalUrls = addedExternalUrls;
    }
    if (plan) {
      updateInput.plan = plan;
    }
    await client.updateAgentSession(sessionId, updateInput);
  } catch (error) {
    console.error("[linear-agent-activity] Failed to update agent session", {
      sessionId,
      externalUrls,
      addedExternalUrls,
      plan,
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

type LinearDaemonActivityUpdate =
  | { type: "action"; summary: string }
  | { type: "plan"; plan: AgentPlanStep[] }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

function buildTerminalActivityUpdate({
  lastAssistantText,
  isDone,
  isError,
  customErrorMessage,
  costUsd,
}: {
  lastAssistantText: string | null;
  isDone: boolean;
  isError: boolean;
  customErrorMessage?: string | null;
  costUsd?: number;
}): LinearDaemonActivityUpdate | null {
  if (isDone && !isError) {
    let body = lastAssistantText ?? "Task completed.";
    if (costUsd && costUsd > 0) {
      body += ` (cost: $${costUsd.toFixed(4)})`;
    }
    return { type: "response", body };
  }

  if (isError) {
    return {
      type: "error",
      body: customErrorMessage?.trim() || "Agent encountered an error.",
    };
  }

  return null;
}

function buildNonTerminalActivityUpdate({
  agentSessionId,
  lastAssistantText,
  latestPlan,
  now,
}: {
  agentSessionId: string;
  lastAssistantText: string | null;
  latestPlan: AgentPlanStep[] | null;
  now: number;
}): LinearDaemonActivityUpdate | null {
  if (latestPlan) {
    return { type: "plan", plan: latestPlan };
  }

  const lastEmit = lastActionEmitMap.get(agentSessionId);
  if (lastEmit !== undefined && now - lastEmit < ACTION_THROTTLE_MS) {
    return null;
  }

  if (!lastAssistantText) {
    return null;
  }

  lastActionEmitMap.set(agentSessionId, now);
  return { type: "action", summary: lastAssistantText };
}

async function getLinearActivityAccessToken({
  organizationId,
  updateType,
}: {
  organizationId: string;
  updateType: LinearDaemonActivityUpdate["type"];
}): Promise<string | null> {
  try {
    const tokenResult = await refreshLinearTokenIfNeeded(organizationId, db);
    if (tokenResult.status !== "ok") {
      console.warn(
        "[linear-agent-activity] Skipping Linear activity: token not available",
        { organizationId, updateType, status: tokenResult.status },
      );
      return null;
    }
    return tokenResult.accessToken;
  } catch (error) {
    console.error(
      "[linear-agent-activity] Token refresh failed, skipping Linear activity",
      { organizationId, updateType, error },
    );
    return null;
  }
}

async function emitDaemonActivityUpdate({
  update,
  agentSessionId,
  accessToken,
  createClient,
}: {
  update: LinearDaemonActivityUpdate;
  agentSessionId: string;
  accessToken: string;
  createClient: LinearClientFactory;
}): Promise<void> {
  switch (update.type) {
    case "action":
      await emitAgentActivity({
        agentSessionId,
        accessToken,
        content: {
          type: "action",
          action: "Working",
          parameter: update.summary,
        },
        ephemeral: true,
        createClient,
      });
      return;
    case "plan":
      await updateAgentSession({
        sessionId: agentSessionId,
        accessToken,
        plan: update.plan,
        createClient,
      });
      return;
    case "response":
      await emitAgentActivity({
        agentSessionId,
        accessToken,
        content: { type: "response", body: update.body },
        createClient,
      });
      return;
    case "error":
      await emitAgentActivity({
        agentSessionId,
        accessToken,
        content: { type: "error", body: update.body },
        createClient,
      });
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

type LinearMentionMetadata = Extract<
  ThreadSourceMetadata,
  { type: "linear-mention" }
>;

export async function emitLinearActivitiesForCanonicalBatch(
  sourceMetadata: LinearMentionMetadata,
  canonicalEvents: readonly CanonicalEvent[],
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
    console.warn(
      "[linear-agent-activity] Skipping Linear activity: legacy thread missing agentSessionId",
      { organizationId: sourceMetadata.organizationId },
    );
    return;
  }

  const organizationId = sourceMetadata.organizationId;
  const nowFn = opts?.now ?? (() => Date.now());
  const createClient = opts?.createClient ?? defaultClientFactory;

  const isDone = opts?.isDone ?? false;
  const isError = opts?.isError ?? false;

  const dbMessages = deriveDBMessagesFromCanonical(canonicalEvents);
  const lastAssistantText = extractLastAssistantTextFromDBMessages(dbMessages);
  const latestPlan = extractLatestAgentPlanFromDBMessages(dbMessages);

  const update =
    buildTerminalActivityUpdate({
      lastAssistantText,
      isDone,
      isError,
      customErrorMessage: opts?.customErrorMessage,
      costUsd: opts?.costUsd,
    }) ??
    buildNonTerminalActivityUpdate({
      agentSessionId,
      lastAssistantText,
      latestPlan,
      now: nowFn(),
    });

  if (!update) {
    return;
  }

  const accessToken = await getLinearActivityAccessToken({
    organizationId,
    updateType: update.type,
  });
  if (!accessToken) {
    return;
  }

  await emitDaemonActivityUpdate({
    update,
    agentSessionId,
    accessToken,
    createClient,
  });
}
