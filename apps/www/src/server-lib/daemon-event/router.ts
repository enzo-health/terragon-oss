import type { DBMessage } from "@terragon/shared";
import { waitUntil } from "@vercel/functions";
import { isQueuedStatus } from "@/agent/thread-status";
import { db } from "@/lib/db";
import { toDBMessage } from "@/agent/msg/toDBMessage";
import {
  getThreadChat,
  getThreadMinimal,
  touchThreadChatUpdatedAt,
  updateThreadChat,
  updateThread,
} from "@terragon/shared/model/threads";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { extendSandboxLife } from "@terragon/sandbox";
import {
  persistSideEffectAgUiMessages,
  persistInvalidTokenRetrySideEffectMarker,
  hasInvalidTokenRetrySideEffectMarker,
} from "@/server-lib/ag-ui-side-effect-messages";
import { findOpenAgUiToolCallsForRun } from "@terragon/shared/model/agent-event-log";
import {
  updateAgentRunContext,
  getAgentRunContextByRunId,
} from "@terragon/shared/model/agent-run-context";
import { publishBroadcastUserMessage } from "@terragon/shared/broadcast-server";
import { getPostHogServer } from "@/lib/posthog-server";
import {
  isAnthropicDownPOST,
  internalPOST,
} from "@/server-lib/internal-request";
import { trackUsageEvents } from "@/server-lib/usage-events";
import { compactThreadChat } from "@/server-lib/compact";
import { maybeProcessFollowUpQueue } from "@/server-lib/process-follow-up-queue";
import { checkpointThread } from "@/server-lib/checkpoint-thread";
import { getEligibleQueuedThreadChats } from "@/server-lib/process-queued-thread";
import {
  hasOtherActiveRuns,
  setActiveThreadChat,
} from "@/agent/sandbox-resource";
import {
  emitLinearActivitiesForDaemonEvent,
  updateAgentSession,
} from "@/server-lib/linear-agent-activity";
import { refreshLinearTokenIfNeeded } from "@/server-lib/linear-oauth";
import {
  classifyMessages,
  buildRunContextFailureUpdates,
  deriveTerminalFailureSource,
  deriveDaemonTerminalErrorInfo,
} from "./message-parser";
import {
  maybeTrackFirstAssistantLatency,
  reportDaemonEventMetrics,
  reportThreadErrorMetrics,
  reportMcpToolCalls,
} from "./analytics-reporter";
import { tryAutoCompactRecovery } from "./recovery/auto-compact";
import { tryOAuthRetryRecovery } from "./recovery/oauth-retry";
import { maybeEmitLinearActivities } from "./linear-activity-emitter";
import {
  handleThreadFinish,
  buildInterruptedToolResultMessages,
} from "./lifecycle-manager";
import type {
  DaemonEventResult,
  DaemonEventContext,
  RouterDependencies,
  ThreadChatUpdateAccumulator,
} from "./types";

/**
 * Default dependency injection table.  Callers (including tests) can override
 * any field to inject mocks / spies.
 */
export function createDefaultDependencies(): RouterDependencies {
  return {
    toDBMessage,
    getThreadChat,
    getThreadMinimal,
    touchThreadChatUpdatedAt,
    updateThreadChat,
    updateThreadChatWithTransition,
    updateThread,
    getFeatureFlagForUser,
    extendSandboxLife,
    persistSideEffectAgUiMessages,
    persistInvalidTokenRetrySideEffectMarker,
    hasInvalidTokenRetrySideEffectMarker,
    findOpenAgUiToolCallsForRun,
    updateAgentRunContext,
    getAgentRunContextByRunId,
    publishBroadcastUserMessage,
    getPostHogServer,
    isAnthropicDownPOST,
    internalPOST,
    trackUsageEvents,
    compactThreadChat,
    maybeProcessFollowUpQueue,
    checkpointThread,
    getEligibleQueuedThreadChats,
    hasOtherActiveRuns,
    setActiveThreadChat,
    emitLinearActivitiesForDaemonEvent,
    refreshLinearTokenIfNeeded,
    updateAgentSession,
  };
}

/**
 * The main router that orchestrates daemon-event handling.
 * All side effects are injected via `deps` so the router is independently testable.
 */
export async function routeDaemonEvent(
  deps: RouterDependencies,
  ctx: DaemonEventContext,
): Promise<DaemonEventResult> {
  const {
    messages,
    threadId,
    threadChatId,
    userId,
    timezone,
    contextUsage,
    runId,
    deferTerminalTransitionToRoute,
    suppressTerminalRecoverySideEffects,
    skipThreadChatPersistence,
  } = ctx;

  if (process.env.NODE_ENV !== "production") {
    console.log(
      "Daemon event",
      "threadId",
      threadId,
      "threadChatId",
      threadChatId,
      "timezone",
      timezone,
      "messageTypes",
      [...new Set(messages.map((m) => m.type))],
      "messageCount",
      messages.length,
    );
  }

  // Heartbeat: empty messages just extend sandbox life and refresh updatedAt
  if (messages.length === 0) {
    const thread = await deps.getThreadMinimal({ db, threadId, userId });
    if (!thread) {
      return {
        success: false,
        error: "Thread not found",
        status: 404,
        threadChatMessageSeq: null,
        terminalRecoveryQueued: false,
      };
    }
    if (thread.codesandboxId && thread.sandboxProvider) {
      waitUntil(
        deps.extendSandboxLife({
          sandboxId: thread.codesandboxId,
          sandboxProvider: thread.sandboxProvider,
        }),
      );
    }
    await deps.touchThreadChatUpdatedAt({ db, threadId, threadChatId });
    return {
      success: true,
      threadChatMessageSeq: null,
      terminalRecoveryQueued: false,
    };
  }

  const [threadChat, thread] = await Promise.all([
    deps.getThreadChat({ db, userId, threadId, threadChatId }),
    deps.getThreadMinimal({ db, threadId, userId }),
  ]);
  if (!threadChat || !thread) {
    return {
      success: false,
      error: "Thread chat not found",
      status: 404,
      threadChatMessageSeq: null,
      terminalRecoveryQueued: false,
    };
  }

  if (
    process.env.NODE_ENV !== "production" &&
    messages.length > 0 &&
    messages.some((m) => m.type === "assistant")
  ) {
    console.log("Daemon event message stats", {
      threadId,
      threadChatId,
      totalMessages: messages.length,
      messageTypes: [...new Set(messages.map((m) => m.type))],
      assistantCount: messages.filter((m) => m.type === "assistant").length,
    });
  }
  if (runId) {
    waitUntil(
      maybeTrackFirstAssistantLatency({
        deps,
        runId,
        userId,
        threadId,
        threadChatId,
        hasAssistantMessage: messages.some((m) => m.type === "assistant"),
        runContext: null,
      }),
    );
  }

  const agent = threadChat.agent ?? "claudeCode";
  const { classification, mutatedMessages } = classifyMessages({
    messages,
    timezone,
    agent,
  });

  waitUntil(
    deps.trackUsageEvents({
      userId,
      costUsd: classification.costUsd,
      agentDurationMs: classification.durationMs,
    }),
  );

  const isThreadFinished =
    classification.isStop || classification.isDone || classification.isError;
  const statusBeforeUpdate = threadChat.status;

  if (isThreadFinished && runId && !deferTerminalTransitionToRoute) {
    const daemonTerminalErrorInfo = deriveDaemonTerminalErrorInfo(messages);
    await deps.updateAgentRunContext({
      db,
      userId,
      runId,
      updates: {
        status: classification.isStop
          ? "stopped"
          : classification.isError
            ? "failed"
            : "completed",
        ...buildRunContextFailureUpdates({
          isError: classification.isError,
          errorMessage: daemonTerminalErrorInfo.errorMessage,
          errorCategory: daemonTerminalErrorInfo.errorCategory,
          terminalReason: classification.isError ? "agent-generic-error" : null,
          failureSource: deriveTerminalFailureSource(messages),
        }),
      },
    });
  }

  if (isThreadFinished) {
    reportDaemonEventMetrics({
      deps,
      userId,
      threadId,
      classification,
      statusBeforeUpdate,
    });
  }

  // Extend sandbox life if both fields are present
  if (thread.codesandboxId && thread.sandboxProvider) {
    waitUntil(
      deps.extendSandboxLife({
        sandboxId: thread.codesandboxId,
        sandboxProvider: thread.sandboxProvider,
      }),
    );
  }
  if (classification.isOverloaded) {
    waitUntil(deps.isAnthropicDownPOST());
  }

  const toDBMessageResults = await Promise.all(
    mutatedMessages.map(async (message) => {
      try {
        return await deps.toDBMessage(message);
      } catch (err) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            "[daemon-event] Failed to convert message to DBMessage, skipping",
            {
              messageType: (message as Record<string, unknown>)?.type,
              err,
            },
          );
        }
        return [] as DBMessage[];
      }
    }),
  );

  const dbMessages: DBMessage[] = [];
  const mcpToolCalls: { serverName: string; toolName: string }[] = [];

  for (const dbMessage of toDBMessageResults) {
    dbMessages.push(...dbMessage);
    for (const dbMsg of dbMessage) {
      if (dbMsg.type === "tool-call" && dbMsg.name.startsWith("mcp__")) {
        const parts = dbMsg.name.split("__");
        if (parts.length >= 3) {
          const serverName = parts[1]!;
          const toolName = parts.slice(2).join("__");
          mcpToolCalls.push({ serverName, toolName });
        }
      }
    }
  }

  if (mcpToolCalls.length > 0) {
    reportMcpToolCalls({ deps, userId, threadId, mcpToolCalls });
  }

  // Build interrupted tool results for unresolved open tool calls
  const messagesToAppend =
    classification.isStop || classification.isError
      ? runId
        ? buildInterruptedToolResultMessages({
            openToolCalls: await deps.findOpenAgUiToolCallsForRun({
              db,
              runId,
            }),
            interruptionReason: classification.isError ? "error" : "user",
          })
        : []
      : [];

  let threadChatUpdates: ThreadChatUpdateAccumulator = {
    appendMessages: [...dbMessages, ...messagesToAppend],
    sessionId: classification.sessionId ?? threadChat.sessionId ?? null,
    errorMessage: null,
    errorMessageInfo: null,
    contextLength: contextUsage ?? undefined,
  };

  let invalidTokenRetryQueued = false;

  if (
    runId &&
    (threadChat.queuedMessages?.length ?? 0) > 0 &&
    (isQueuedStatus(statusBeforeUpdate) || statusBeforeUpdate === "booting")
  ) {
    threadChatUpdates.replaceQueuedMessages = [];
  }

  if (classification.isError) {
    if (classification.isPromptTooLong) {
      threadChatUpdates.errorMessage = "prompt-too-long";
      threadChatUpdates.errorMessageInfo = null;
    } else if (classification.customErrorMessage) {
      threadChatUpdates.errorMessage = "agent-generic-error";
      threadChatUpdates.errorMessageInfo = classification.customErrorMessage;
    } else {
      threadChatUpdates.errorMessage = "agent-generic-error";
      threadChatUpdates.errorMessageInfo = "";
    }
    reportThreadErrorMetrics({
      deps,
      userId,
      threadId,
      errorType: threadChatUpdates.errorMessage,
    });
  }

  const allowTerminalRecoverySideEffects = !suppressTerminalRecoverySideEffects;

  // Auto-compact recovery
  if (classification.isPromptTooLong && allowTerminalRecoverySideEffects) {
    const compactResult = await tryAutoCompactRecovery({
      deps,
      userId,
      threadId,
      threadChatId: threadChat.id,
      threadChatUpdates,
      isPromptTooLong: classification.isPromptTooLong,
      allowTerminalRecoverySideEffects,
    });
    if (compactResult.recovered) {
      threadChatUpdates = compactResult.threadChatUpdates;
      classification.isError = compactResult.isError;
      classification.isPromptTooLong = compactResult.isPromptTooLong;
      classification.isDone = compactResult.isDone;
    }
  }

  // OAuth retry recovery
  if (classification.isOAuthTokenRevoked && allowTerminalRecoverySideEffects) {
    const oauthResult = await tryOAuthRetryRecovery({
      deps,
      userId,
      threadId,
      threadChatId: threadChat.id,
      threadChatUpdates,
      isOAuthTokenRevoked: classification.isOAuthTokenRevoked,
      allowTerminalRecoverySideEffects,
    });
    if (oauthResult.recovered) {
      invalidTokenRetryQueued = oauthResult.invalidTokenRetryQueued;
      threadChatUpdates = oauthResult.threadChatUpdates;
      classification.isError = oauthResult.isError;
      classification.isOAuthTokenRevoked = oauthResult.isOAuthTokenRevoked;
      classification.isDone = oauthResult.isDone;
    }
  }

  // Linear activity emission
  await maybeEmitLinearActivities({
    deps,
    threadId,
    sourceType: thread.sourceType ?? null,
    sourceMetadata: thread.sourceMetadata ?? null,
    messages: mutatedMessages,
    classification,
    threadChatUpdates,
    suppressTerminalRecoverySideEffects,
  });

  const terminalRecoveryQueued =
    (threadChatUpdates.appendQueuedMessages?.length ?? 0) > 0;

  if (skipThreadChatPersistence) {
    return {
      success: true,
      threadChatMessageSeq: null,
      terminalRecoveryQueued,
    };
  }

  // Skip checkpoint when done and disabled or stopped
  let shouldSkipCheckpoint = false;
  if (classification.isDone && !classification.isError) {
    shouldSkipCheckpoint =
      classification.isStop || !!thread.disableGitCheckpointing;
  }

  // Pre-broadcast
  const hasPreviewMessages = threadChatUpdates.appendMessages.length > 0;
  if (hasPreviewMessages) {
    deps
      .publishBroadcastUserMessage({
        type: "user",
        id: userId,
        data: {
          threadPatches: [
            {
              threadId,
              threadChatId: threadChat.id,
              op: "upsert",
              appendMessages: threadChatUpdates.appendMessages,
            },
          ],
        },
      })
      .catch((error) => {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[handle-daemon-event] pre-broadcast failed", {
            threadId,
            error,
          });
        }
      });
  }

  const shouldDeferTerminalTransition =
    deferTerminalTransitionToRoute && isThreadFinished;

  if (shouldDeferTerminalTransition) {
    threadChatUpdates.errorMessage = null;
    threadChatUpdates.errorMessageInfo = null;
  }

  let didUpdateStatus: boolean;
  let threadChatMessageSeq: number | null = null;
  let broadcastData:
    | Parameters<typeof deps.publishBroadcastUserMessage>[0]
    | undefined;

  try {
    if (shouldDeferTerminalTransition) {
      await deps.updateThread({
        db,
        userId,
        threadId,
        updates: { bootingSubstatus: null },
      });
      const chatUpdateResult = await deps.updateThreadChat({
        db,
        userId,
        threadId,
        threadChatId: threadChat.id,
        updates:
          threadChatUpdates as import("@terragon/shared").ThreadChatInsert,
        skipAppendMessagesInBroadcast: !!hasPreviewMessages,
        skipBroadcast: true,
      });
      didUpdateStatus = false;
      threadChatMessageSeq = chatUpdateResult.chatSequence ?? null;
      broadcastData = chatUpdateResult.broadcastData;
    } else {
      const result = await deps.updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId: threadChat.id,
        markAsUnread: classification.isDone || classification.isError,
        updates: { bootingSubstatus: null },
        chatUpdates:
          threadChatUpdates as import("@terragon/shared").ThreadChatInsert,
        eventType: classification.isStop
          ? "assistant.message_stop"
          : classification.isRateLimited && classification.rateLimitResetTime
            ? "system.agent-rate-limit"
            : classification.isError
              ? "assistant.message_error"
              : classification.isDone && shouldSkipCheckpoint
                ? "assistant.message_done_skip_checkpoint"
                : classification.isDone
                  ? "assistant.message_done"
                  : "assistant.message",
        rateLimitResetTime: classification.rateLimitResetTime,
        skipAppendMessagesInBroadcast: !!hasPreviewMessages,
        skipBroadcast: true,
      });
      didUpdateStatus = result.didUpdateStatus;
      threadChatMessageSeq = result.chatSequence ?? null;
      broadcastData = result.broadcastData;
    }
  } catch (dbError) {
    if (hasPreviewMessages) {
      deps
        .publishBroadcastUserMessage({
          type: "user",
          id: userId,
          data: {
            threadPatches: [
              {
                threadId,
                threadChatId: threadChat.id,
                op: "refetch",
                refetch: ["chat"],
              },
            ],
          },
        })
        .catch((broadcastError) => {
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              "[handle-daemon-event] error-refetch broadcast failed",
              {
                threadId,
                broadcastError,
              },
            );
          }
        });
    }
    throw dbError;
  }

  await deps.persistSideEffectAgUiMessages({
    db,
    threadId,
    threadChatId: threadChat.id,
    messages: threadChatUpdates.appendMessages ?? [],
    source: "daemon-side-effect",
    chatSequence: threadChatMessageSeq ?? undefined,
    runId,
  });
  if (invalidTokenRetryQueued) {
    await deps.persistInvalidTokenRetrySideEffectMarker({
      db,
      threadId,
      threadChatId: threadChat.id,
      runId,
      chatSequence: threadChatMessageSeq ?? undefined,
    });
  }

  // Async broadcast
  if (broadcastData) {
    waitUntil(
      deps.publishBroadcastUserMessage(broadcastData).catch((error) => {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[handle-daemon-event] async broadcast failed", {
            threadId,
            error,
          });
        }
      }),
    );
  }

  const isThreadFinishedAfterRecovery =
    classification.isStop || classification.isDone || classification.isError;

  if (
    isThreadFinishedAfterRecovery &&
    didUpdateStatus &&
    thread.codesandboxId
  ) {
    waitUntil(
      handleThreadFinish({
        deps,
        userId,
        threadId,
        threadChatId: threadChat.id,
        sandboxId: thread.codesandboxId,
        statusBeforeUpdate,
        isRateLimited: classification.isRateLimited,
        isError: classification.isError,
        shouldSkipCheckpoint,
        sourceType: thread.sourceType ?? null,
        sourceMetadata: thread.sourceMetadata ?? null,
        runId: runId ?? threadChat.id,
        followUpRunId: runId ?? null,
      }),
    );
  }

  return {
    success: true,
    threadChatMessageSeq,
    terminalRecoveryQueued:
      (threadChatUpdates.appendQueuedMessages?.length ?? 0) > 0,
  };
}
