import {
  classifyRecoverableTerminal,
  type RecoverableParseMessage,
} from "@/agent/msg/helpers";
import type { RecoverableTerminal } from "@terragon/agent/canonical-events";
import type { DBSystemMessage, DBUserMessage } from "@terragon/shared";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { updateThreadChat } from "@terragon/shared/model/threads";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { db } from "@/lib/db";
import {
  hasInvalidTokenRetrySideEffectMarker,
  persistInvalidTokenRetrySideEffectMarker,
  persistSideEffectAgUiMessages,
} from "@/server-lib/ag-ui-side-effect-messages";
import { compactThreadChat } from "@/server-lib/compact";

export type RouteRecoveryPlan =
  | { outcome: "no-recovery" }
  | {
      outcome: "fire";
      kind: "context-exhausted" | "oauth-token-revoked";
      sideEffectMessage: DBSystemMessage;
      clearSessionAndContext: boolean;
      persistInvalidTokenMarker: boolean;
    }
  | { outcome: "rate-limit"; rateLimitResetTimeMs: number | null };

export async function planRouteRecovery({
  daemonStampedRecoverable,
  messages,
  agent,
  timezone,
  userId,
  threadId,
  threadChatId,
}: {
  daemonStampedRecoverable: RecoverableTerminal | null | undefined;
  messages: readonly RecoverableParseMessage[];
  agent: string | null | undefined;
  timezone: string;
  userId: string;
  threadId: string;
  threadChatId: string;
}): Promise<RouteRecoveryPlan> {
  const recoverable =
    daemonStampedRecoverable ??
    classifyRecoverableTerminal({
      messages: [...messages],
      agent,
      timezone,
    });
  if (!recoverable) {
    return { outcome: "no-recovery" };
  }

  if (recoverable.kind === "rate-limit") {
    return {
      outcome: "rate-limit",
      rateLimitResetTimeMs:
        recoverable.retryAfterMs != null
          ? Date.now() + recoverable.retryAfterMs
          : null,
    };
  }

  if (recoverable.kind === "oauth-token-revoked") {
    const alreadyRetried = await hasInvalidTokenRetrySideEffectMarker({
      db,
      threadChatId,
    });
    if (alreadyRetried) {
      return { outcome: "no-recovery" };
    }
    return {
      outcome: "fire",
      kind: "oauth-token-revoked",
      sideEffectMessage: {
        type: "system",
        message_type: "invalid-token-retry",
        parts: [],
        timestamp: new Date().toISOString(),
      },
      clearSessionAndContext: false,
      persistInvalidTokenMarker: true,
    };
  }

  const shouldAutoCompact = await getFeatureFlagForUser({
    db,
    userId,
    flagName: "autoCompactOnContextError",
  });
  if (!shouldAutoCompact) {
    return { outcome: "no-recovery" };
  }
  const compactResult = await compactThreadChat({
    userId,
    threadId,
    threadChatId,
  });
  if (!compactResult?.summary) {
    return { outcome: "no-recovery" };
  }
  return {
    outcome: "fire",
    kind: "context-exhausted",
    sideEffectMessage: {
      type: "system",
      message_type: "compact-result",
      parts: [
        {
          type: "text",
          text: `Thread was automatically compacted due to context length limit. Summary:\n\n${compactResult.summary}`,
        },
      ],
      timestamp: new Date().toISOString(),
    },
    clearSessionAndContext: true,
    persistInvalidTokenMarker: false,
  };
}

export async function applyRouteRecoveryFire({
  plan,
  userId,
  threadId,
  threadChatId,
  runId,
}: {
  plan: Extract<RouteRecoveryPlan, { outcome: "fire" }>;
  userId: string;
  threadId: string;
  threadChatId: string;
  runId: string;
}): Promise<void> {
  if (plan.persistInvalidTokenMarker) {
    await persistInvalidTokenRetrySideEffectMarker({
      db,
      threadId,
      threadChatId,
      runId,
    });
  }
  await persistSideEffectAgUiMessages({
    db,
    threadId,
    threadChatId,
    messages: [plan.sideEffectMessage],
    source: "daemon-side-effect",
    runId,
  });
  const continueMessage: DBUserMessage = {
    type: "user",
    model: null,
    parts: [{ type: "text", text: "Continue" }],
    timestamp: new Date().toISOString(),
  };
  await updateThreadChat({
    db,
    userId,
    threadId,
    threadChatId,
    updates: {
      appendQueuedMessages: [continueMessage],
      ...(plan.clearSessionAndContext
        ? { sessionId: null, contextLength: null }
        : {}),
    },
    skipBroadcast: true,
  });
}

export async function applyRouteRecoveryRateLimit({
  plan,
  userId,
  threadId,
  threadChatId,
}: {
  plan: Extract<RouteRecoveryPlan, { outcome: "rate-limit" }>;
  userId: string;
  threadId: string;
  threadChatId: string;
}): Promise<void> {
  await updateThreadChatWithTransition({
    db,
    userId,
    threadId,
    threadChatId,
    eventType: "system.agent-rate-limit",
    ...(plan.rateLimitResetTimeMs != null
      ? { rateLimitResetTime: plan.rateLimitResetTimeMs }
      : {}),
    markAsUnread: true,
  });
}
