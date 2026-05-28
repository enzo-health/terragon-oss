import type { RouterDependencies } from "./types";
import type { MessageClassification } from "./types";

const FIRST_ASSISTANT_TRACKED_PREFIX = "run-first-assistant-tracked:";
const FOLLOW_UP_TTFR_START_PREFIX = "follow-up-ttfr-start:";

function getFirstAssistantTrackedKey(runId: string) {
  return `${FIRST_ASSISTANT_TRACKED_PREFIX}${runId}`;
}

function getFollowUpTtfrStartKey({
  userId,
  threadId,
  threadChatId,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
}) {
  return `${FOLLOW_UP_TTFR_START_PREFIX}${userId}:${threadId}:${threadChatId}`;
}

export async function maybeTrackFirstAssistantLatency(params: {
  deps: RouterDependencies;
  runId: string;
  userId: string;
  threadId: string;
  threadChatId: string;
  hasAssistantMessage: boolean;
  runContext?: Awaited<
    ReturnType<
      typeof import("@terragon/shared/model/agent-run-context").getAgentRunContextByRunId
    >
  > | null;
}): Promise<void> {
  const {
    deps,
    runId,
    userId,
    threadId,
    threadChatId,
    hasAssistantMessage,
    runContext,
  } = params;
  if (!hasAssistantMessage) {
    return;
  }
  try {
    const redis = await import("@/lib/redis").then((m) => m.redis);
    const tracked = await redis.set(getFirstAssistantTrackedKey(runId), "1", {
      nx: true,
      ex: 60 * 60 * 24,
    });
    if (tracked !== "OK") {
      return;
    }
    const [fetchedRunContext, followUpStartRaw] = await Promise.all([
      runContext ??
        deps.getAgentRunContextByRunId({
          db: (await import("@/lib/db")).db,
          runId,
          userId,
        }),
      redis.get<string>(
        getFollowUpTtfrStartKey({ userId, threadId, threadChatId }),
      ),
    ]);
    const nowMs = Date.now();
    const runDispatchToFirstAssistantMs = fetchedRunContext
      ? Math.max(0, nowMs - new Date(fetchedRunContext.createdAt).getTime())
      : null;
    const followUpStartMs = followUpStartRaw
      ? Number.parseInt(followUpStartRaw, 10)
      : null;
    const followUpToFirstAssistantMs =
      followUpStartMs && !Number.isNaN(followUpStartMs)
        ? Math.max(0, nowMs - followUpStartMs)
        : null;

    deps.getPostHogServer().capture({
      distinctId: userId,
      event: "follow_up_first_assistant_latency",
      properties: {
        runId,
        threadId,
        threadChatId,
        runDispatchToFirstAssistantMs,
        followUpToFirstAssistantMs,
      },
    });
  } catch (error) {
    console.warn("Failed to track first assistant latency", {
      runId,
      threadId,
      threadChatId,
      error,
    });
  }
}

export function reportDaemonEventMetrics(params: {
  deps: RouterDependencies;
  userId: string;
  threadId: string;
  classification: MessageClassification;
  statusBeforeUpdate: string;
}): void {
  const { deps, userId, threadId, classification, statusBeforeUpdate } = params;
  const {
    isStop,
    isDone,
    isError,
    durationMs,
    costUsd,
    isRateLimited,
    rateLimitResetTime,
    isPromptTooLong,
  } = classification;

  if (isStop || isDone || isError) {
    deps.getPostHogServer().capture({
      distinctId: userId,
      event: "daemon_event",
      properties: {
        threadId,
        statusBeforeUpdate,
        isStop,
        isDone,
        isError,
        durationMs,
        costUsd,
        isRateLimited,
        rateLimitResetTime,
        isPromptTooLong,
      },
    });
  }
}

export function reportThreadErrorMetrics(params: {
  deps: RouterDependencies;
  userId: string;
  threadId: string;
  errorType: string | null;
}): void {
  const { deps, userId, threadId, errorType } = params;
  if (!errorType) return;
  deps.getPostHogServer().capture({
    distinctId: userId,
    event: "thread_error",
    properties: {
      threadId,
      errorType,
    },
  });
}

export function reportMcpToolCalls(params: {
  deps: RouterDependencies;
  userId: string;
  threadId: string;
  mcpToolCalls: { serverName: string; toolName: string }[];
}): void {
  const { deps, userId, threadId, mcpToolCalls } = params;
  for (const toolCall of mcpToolCalls) {
    deps.getPostHogServer().capture({
      distinctId: userId,
      event: "mcp_tool_call",
      properties: {
        threadId,
        mcpServerName: toolCall.serverName,
        mcpToolName: toolCall.toolName,
      },
    });
  }
}

export function reportAutoCompactEvent(params: {
  deps: RouterDependencies;
  userId: string;
  threadId: string;
  threadChatId: string;
}): void {
  const { deps, userId, threadId, threadChatId } = params;
  deps.getPostHogServer().capture({
    distinctId: userId,
    event: "auto_compact_on_context_error",
    properties: {
      threadId,
      threadChatId,
      errorType: "prompt-too-long",
    },
  });
}

export function reportOAuthRetryEvent(params: {
  deps: RouterDependencies;
  userId: string;
  threadId: string;
}): void {
  const { deps, userId, threadId } = params;
  deps.getPostHogServer().capture({
    distinctId: userId,
    event: "oauth_token_revoked_retry",
    properties: {
      threadId,
    },
  });
}
