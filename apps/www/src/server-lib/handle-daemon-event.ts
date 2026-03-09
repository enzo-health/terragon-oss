import { toDBMessage } from "@/agent/msg/toDBMessage";
import { getPendingToolCallErrorMessages } from "@/lib/db-message-helpers";
import { db } from "@/lib/db";
import { ClaudeMessage } from "@terragon/daemon/shared";
import {
  DBMessage,
  DBSystemMessage,
  DBUserMessage,
  ThreadChatInsert,
  ThreadStatus,
} from "@terragon/shared";
import {
  getThreadChat,
  getThreadMinimal,
  touchThreadChatUpdatedAt,
} from "@terragon/shared/model/threads";
import { waitUntil } from "@vercel/functions";
import { setActiveThreadChat } from "@/agent/sandbox-resource";
import { extendSandboxLife } from "@terragon/sandbox";
import { checkpointThread } from "@/server-lib/checkpoint-thread";
import {
  internalPOST,
  isAnthropicDownPOST,
} from "@/server-lib/internal-request";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { getPostHogServer } from "@/lib/posthog-server";
import { maybeProcessFollowUpQueue } from "@/server-lib/process-follow-up-queue";
import {
  parseClaudeOverloadedMessage,
  parseClaudePromptTooLongMessage,
  parseClaudeRateLimitMessage,
  parseClaudeRateLimitMessageStr,
  parseCodexErrorMessage,
  parseCodexRateLimitMessage,
  parseClaudeOAuthTokenRevokedMessage,
} from "@/agent/msg/helpers";
import { getEligibleQueuedThreadChats } from "./process-queued-thread";
import { trackUsageEvents } from "./usage-events";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { compactThreadChat } from "./compact";
import {
  emitLinearActivitiesForDaemonEvent,
  updateAgentSession,
} from "./linear-agent-activity";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import {
  getActiveSdlcLoopForThread,
  getUnresolvedBlockingDeepReviewFindings,
  getUnresolvedBlockingCarmackReviewFindings,
  type DeliveryLoopFailureCategory,
} from "@terragon/shared/model/delivery-loop";
import {
  formatReviewFindings,
  queueSdlcFollowUpMessage,
} from "@/server-lib/checkpoint-thread-internal";
import { refreshLinearTokenIfNeeded } from "./linear-oauth";
import type {
  ThreadSourceMetadata,
  SdlcLoopState,
} from "@terragon/shared/db/types";
import { publicAppUrl } from "@terragon/env/next-public";
import { redis } from "@/lib/redis";
import {
  evaluateRetryDecision,
  resetRetryCounter,
} from "@/server-lib/delivery-loop/retry-policy";

/** SDLC phases eligible for auto-retry on generic agent error. */
const SDLC_AUTO_RETRY_PHASES: ReadonlySet<SdlcLoopState> = new Set([
  "implementing",
  "reviewing",
  "ui_testing",
  "pr_babysitting",
  "blocked_on_agent_fixes",
  "blocked_on_ci",
  "blocked_on_review_threads",
]);

/**
 * Classify a daemon-reported error message into a DeliveryLoopFailureCategory.
 * This mirrors the classification in `apps/www/src/agent/daemon.ts` but operates
 * on the error string the daemon sends back via its event stream.
 */
function classifyDaemonEventError(
  errorMessage: string | null,
): DeliveryLoopFailureCategory {
  if (!errorMessage) return "unknown";
  const msg = errorMessage.toLowerCase();
  if (
    /unix socket|econnrefused|enoent.*socket|daemon.*not running|daemon.*dead/.test(
      msg,
    )
  )
    return "daemon_unreachable";
  if (/spawn|fork|exec|eacces|cannot find module/.test(msg))
    return "daemon_spawn_failed";
  if (/timeout|timed out|ack.*timeout/.test(msg)) return "dispatch_ack_timeout";
  if (/codex.*app.?server.*exit/.test(msg)) return "codex_app_server_exit";
  if (/codex.*subagent/.test(msg)) return "codex_subagent_failed";
  if (/codex.*turn.*fail|codex.*error/.test(msg)) return "codex_turn_failed";
  if (/claude.*exit|claude.*crash|claude.*runtime/.test(msg))
    return "claude_runtime_exit";
  if (/claude.*dispatch|dispatch.*fail/.test(msg))
    return "claude_dispatch_failed";
  if (/gate.*fail|gate.*block/.test(msg)) return "gate_failed";
  return "unknown";
}

const FIRST_ASSISTANT_TRACKED_PREFIX = "run-first-assistant-tracked:";
const FOLLOW_UP_TTFR_START_PREFIX = "follow-up-ttfr-start:";
const ACTIVE_PROCESSING_STATUSES: ReadonlySet<ThreadStatus> = new Set([
  "queued",
  "queued-blocked",
  "queued-sandbox-creation-rate-limit",
  "queued-tasks-concurrency",
  "queued-agent-rate-limit",
  "booting",
  "working",
  "stopping",
  "checkpointing",
]);
const FOLLOW_UP_ACK_PENDING_STATUSES: ReadonlySet<ThreadStatus> = new Set([
  "queued",
  "queued-blocked",
  "queued-sandbox-creation-rate-limit",
  "queued-tasks-concurrency",
  "queued-agent-rate-limit",
  "booting",
]);

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

async function maybeTrackFirstAssistantLatency({
  runId,
  userId,
  threadId,
  threadChatId,
  hasAssistantMessage,
}: {
  runId: string | null;
  userId: string;
  threadId: string;
  threadChatId: string;
  hasAssistantMessage: boolean;
}) {
  if (!runId || !hasAssistantMessage) {
    return;
  }
  try {
    const tracked = await redis.set(getFirstAssistantTrackedKey(runId), "1", {
      nx: true,
      ex: 60 * 60 * 24,
    });
    if (tracked !== "OK") {
      return;
    }
    const [runContext, followUpStartRaw] = await Promise.all([
      getAgentRunContextByRunId({ db, runId, userId }),
      redis.get<string>(
        getFollowUpTtfrStartKey({ userId, threadId, threadChatId }),
      ),
    ]);
    const nowMs = Date.now();
    const runDispatchToFirstAssistantMs = runContext
      ? Math.max(0, nowMs - new Date(runContext.createdAt).getTime())
      : null;
    const followUpStartMs = followUpStartRaw
      ? Number.parseInt(followUpStartRaw, 10)
      : null;
    const followUpToFirstAssistantMs =
      followUpStartMs && !Number.isNaN(followUpStartMs)
        ? Math.max(0, nowMs - followUpStartMs)
        : null;

    getPostHogServer().capture({
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

export async function handleDaemonEvent({
  messages,
  threadId,
  threadChatId,
  userId,
  timezone,
  contextUsage,
  runId = null,
}: {
  messages: ClaudeMessage[];
  threadId: string;
  threadChatId: string;
  userId: string;
  timezone: string;
  contextUsage: number | null;
  runId?: string | null;
}) {
  console.log(
    "Daemon event",
    "threadId",
    threadId,
    "threadChatId",
    threadChatId,
    "timezone",
    timezone,
    "messages",
    JSON.stringify(messages, null, 2),
  );

  // Heartbeat: empty messages just extend sandbox life and refresh updatedAt
  if (messages.length === 0) {
    const thread = await getThreadMinimal({ db, threadId, userId });
    if (!thread) {
      return { success: false, error: "Thread not found", status: 404 };
    }
    if (thread.codesandboxId && thread.sandboxProvider) {
      waitUntil(
        extendSandboxLife({
          sandboxId: thread.codesandboxId,
          sandboxProvider: thread.sandboxProvider,
        }),
      );
    }
    await touchThreadChatUpdatedAt({ db, threadId, threadChatId });
    return { success: true };
  }

  const [threadChat, thread] = await Promise.all([
    getThreadChat({
      db,
      userId,
      threadId,
      threadChatId,
    }),
    getThreadMinimal({ db, threadId, userId }),
  ]);
  if (!threadChat || !thread) {
    return { success: false, error: "Thread chat not found", status: 404 };
  }
  console.log("Thread chat status: ", threadChat.status);

  if (messages.length > 0 && messages.some((m) => m.type === "assistant")) {
    console.log("Daemon event message stats", {
      threadId,
      threadChatId,
      totalMessages: messages.length,
      messageTypes: [...new Set(messages.map((m) => m.type))],
      assistantCount: messages.filter((m) => m.type === "assistant").length,
    });
  }
  waitUntil(
    maybeTrackFirstAssistantLatency({
      runId,
      userId,
      threadId,
      threadChatId,
      hasAssistantMessage: messages.some((m) => m.type === "assistant"),
    }),
  );

  let isStop = false;
  let isDone = false;
  let isError = false;
  let sessionId: string | null = null;
  let durationMs = 0;
  let costUsd = 0;
  let isRateLimited = false;
  let isOverloaded = false;
  let rateLimitResetTime: number | undefined;
  let isPromptTooLong = false;
  let customErrorMessage: string | null = null;
  let isOAuthTokenRevoked = false;
  for (const message of messages) {
    if (message.type === "custom-stop") {
      isStop = true;
      durationMs = message.duration_ms ?? 0;
    }
    if (message.type === "custom-error") {
      isError = true;
      customErrorMessage = message.error_info ?? null;
      durationMs = message.duration_ms ?? 0;
    }
    if (message.type === "result") {
      isDone = true;
      durationMs = message.duration_ms ?? 0;
      costUsd = "total_cost_usd" in message ? message.total_cost_usd : 0;
      if (message.is_error) {
        isError = true;
        customErrorMessage = "error" in message ? message.error : null;
      }
      if (threadChat.agent === "claudeCode") {
        const rateLimitResult = parseClaudeRateLimitMessage({
          message,
          timezone,
        });
        if (rateLimitResult) {
          isRateLimited = rateLimitResult.isRateLimited;
          rateLimitResetTime = rateLimitResult.rateLimitResetTime ?? undefined;
        }
        const overloadedResult = parseClaudeOverloadedMessage(message);
        if (overloadedResult) {
          isOverloaded = true;
        }

        const promptTooLongResult = parseClaudePromptTooLongMessage(message);
        if (promptTooLongResult) {
          isPromptTooLong = true;
          isError = true;
        }

        const oauthTokenRevokedResult =
          parseClaudeOAuthTokenRevokedMessage(message);
        if (oauthTokenRevokedResult) {
          isOAuthTokenRevoked = true;
          isError = true;
        }
      }
      if (threadChat.agent === "codex") {
        // Check for Codex rate limits
        const codexRateLimitResult = parseCodexRateLimitMessage(message);
        if (codexRateLimitResult) {
          isRateLimited = codexRateLimitResult.isRateLimited;
          rateLimitResetTime =
            codexRateLimitResult.rateLimitResetTime ?? undefined;
        }
        const maybeCodexErrorMessage = parseCodexErrorMessage(message);
        if (maybeCodexErrorMessage) {
          isError = true;
          customErrorMessage = maybeCodexErrorMessage;
        }
      }
    }
    if (message.type === "assistant") {
      if (threadChat.agent === "claudeCode") {
        const content = message.message.content;
        if (typeof content === "string") {
          const rateLimitResult = parseClaudeRateLimitMessageStr({
            result: content,
            timezone,
          });
          if (rateLimitResult?.timezoneIsAmbiguous) {
            message.message.content += ` (${timezone})`;
          }
        } else if (content.length === 1) {
          const messageStr =
            (content[0]!.type === "text" && content[0]!.text) || "";
          const rateLimitResult = parseClaudeRateLimitMessageStr({
            result: messageStr,
            timezone,
          });
          if (rateLimitResult?.timezoneIsAmbiguous) {
            message.message.content = [
              { type: "text", text: `${messageStr} (${timezone})` },
            ];
          }
        }
      }
    }

    if (!sessionId) {
      // For the sessionId, only look at assistant and user messages.
      // since these are the messages that actually get persisted by claude
      // into the <session_id>.jsonl files. Other messages like "system" or "result"
      // don't get persisted and don't guarantee a valid session_id. (eg. claude
      // sends a system init message with a session_id, but gets killed before it
      // can respond to the user message, so the session_id is never persisted)
      if (message.type === "assistant" || message.type === "user") {
        if (message.session_id) {
          sessionId = message.session_id;
        }
      }
    }
  }
  waitUntil(
    trackUsageEvents({
      userId,
      costUsd,
      agentDurationMs: durationMs,
    }),
  );
  const isThreadFinished = isStop || isDone || isError;
  const statusBeforeUpdate = threadChat.status;
  if (isThreadFinished) {
    getPostHogServer().capture({
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
  // Extend the life of the sandbox.
  waitUntil(
    extendSandboxLife({
      sandboxId: thread.codesandboxId!,
      sandboxProvider: thread.sandboxProvider!,
    }),
  );
  if (isOverloaded) {
    waitUntil(isAnthropicDownPOST());
  }
  const dbMessages: DBMessage[] = [];
  const mcpToolCalls: { serverName: string; toolName: string }[] = [];

  for (const message of messages) {
    const dbMessage = toDBMessage(message);
    dbMessages.push(...dbMessage);

    // Track MCP tool calls
    for (const dbMsg of dbMessage) {
      if (dbMsg.type === "tool-call" && dbMsg.name.startsWith("mcp__")) {
        // Parse MCP tool name format: mcp__<server>__<tool>
        const parts = dbMsg.name.split("__");
        if (parts.length >= 3) {
          const serverName = parts[1]!;
          const toolName = parts.slice(2).join("__"); // Handle tool names with "__" in them
          mcpToolCalls.push({ serverName, toolName });
        }
      }
    }
  }

  // Track MCP tool calls
  if (mcpToolCalls.length > 0) {
    for (const toolCall of mcpToolCalls) {
      getPostHogServer().capture({
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

  // If it's a stop or error message, we need to append messages that update pending
  // tool calls to the error state.
  const messagesToAppend =
    isStop || isError
      ? getPendingToolCallErrorMessages({
          messages: [...(threadChat.messages ?? []), ...dbMessages],
          interruptionReason: isError ? "error" : "user",
        })
      : [];

  const threadChatUpdates: ThreadChatInsert = {
    appendMessages: [...dbMessages, ...messagesToAppend],
    sessionId: sessionId ?? threadChat.sessionId ?? null,
    errorMessage: null,
    errorMessageInfo: null,
    contextLength: contextUsage ?? undefined,
  };
  if (
    runId &&
    (threadChat.queuedMessages?.length ?? 0) > 0 &&
    FOLLOW_UP_ACK_PENDING_STATUSES.has(statusBeforeUpdate)
  ) {
    threadChatUpdates.replaceQueuedMessages = [];
  }
  if (isError) {
    if (isPromptTooLong) {
      threadChatUpdates.errorMessage = "prompt-too-long";
      threadChatUpdates.errorMessageInfo = null;
    } else if (customErrorMessage) {
      threadChatUpdates.errorMessage = "agent-generic-error";
      threadChatUpdates.errorMessageInfo = customErrorMessage;
    } else {
      threadChatUpdates.errorMessage = "agent-generic-error";
      // TODO: We could have the daemon send this.
      threadChatUpdates.errorMessageInfo = "";
    }
    getPostHogServer().capture({
      distinctId: userId,
      event: "thread_error",
      properties: {
        threadId,
        errorType: threadChatUpdates.errorMessage,
        failureCategory: classifyDaemonEventError(customErrorMessage),
      },
    });
  }

  // Check if we should auto-compact when we get a prompt-too-long error
  if (isPromptTooLong) {
    const shouldAutoCompact = await getFeatureFlagForUser({
      db,
      userId,
      flagName: "autoCompactOnContextError",
    });

    if (shouldAutoCompact) {
      console.log("Auto-compacting due to prompt-too-long error", {
        threadId,
        threadChatId: threadChat.id,
      });
      getPostHogServer().capture({
        distinctId: userId,
        event: "auto_compact_on_context_error",
        properties: {
          threadId,
          threadChatId: threadChat.id,
          errorType: "prompt-too-long",
        },
      });

      // Attempt to compact the thread
      const compactResult = await compactThreadChat({
        userId,
        threadId,
        threadChatId: threadChat.id,
      });

      if (compactResult && compactResult.summary) {
        console.log(`Successfully compacted after prompt-too-long error`, {
          threadId,
          threadChatId: threadChat.id,
        });
        // Add a system message about the auto-compact
        const compactMessage: DBMessage = {
          type: "system",
          message_type: "compact-result",
          parts: [
            {
              type: "text",
              text: `Thread was automatically compacted due to context length limit. Summary:\n\n${compactResult.summary}`,
            },
          ],
          timestamp: new Date().toISOString(),
        };

        // Create a "Continue" message to restart the agent
        const continueMessage: DBUserMessage = {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "Continue" }],
          timestamp: new Date().toISOString(),
        };

        // Ensure appendMessages is an array before pushing
        if (!threadChatUpdates.appendMessages) {
          threadChatUpdates.appendMessages = [];
        }
        // Only append the compact message to the thread history
        threadChatUpdates.appendMessages.push(compactMessage);

        // Queue the Continue message to be processed after the thread update
        threadChatUpdates.appendQueuedMessages = [continueMessage];

        // Clear the error since we've handled it with compacting
        threadChatUpdates.errorMessage = null;
        threadChatUpdates.errorMessageInfo = null;
        threadChatUpdates.contextLength = null;
        threadChatUpdates.sessionId = null;

        // Mark that we've recovered from the error and the thread is done
        // This ensures the thread transitions properly and processes queued messages
        isError = false;
        isPromptTooLong = false;
        isDone = true; // Mark as done so the thread completes normally
      } else {
        console.log(`Failed to compact after prompt-too-long error`, {
          threadId,
          threadChatId: threadChat.id,
        });
      }
    }
  }

  // Handle OAuth token revoked error with automatic retry
  if (isOAuthTokenRevoked) {
    console.log(`OAuth token revoked error detected, checking for retry`, {
      threadId,
      threadChatId: threadChat.id,
    });

    // Check if the previous non-agent message is already an invalid-token-retry system message
    const allMessages = [...(threadChat.messages ?? []), ...dbMessages];
    let shouldRetry = true;
    // Look backwards through messages see if we've already retried.
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const msg = allMessages[i];
      if (msg?.type === "user") {
        const msgBefore = allMessages[i - 1];
        const isRetryAndContinue =
          msg.parts.length === 1 &&
          msg.parts[0]?.type === "text" &&
          msg.parts[0]?.text.toLowerCase().includes("continue") &&
          msgBefore?.type === "system" &&
          msgBefore?.message_type === "invalid-token-retry";
        if (isRetryAndContinue) {
          shouldRetry = false;
          console.log(
            "Skipping retry because previous message is already an invalid-token-retry",
            {
              threadId,
              threadChatId: threadChat.id,
            },
          );
          break;
        }
        break;
      }
    }
    if (shouldRetry) {
      console.log("Adding invalid-token-retry and queueing retry");
      // Add a system message about the retry
      const invalidTokenRetryMessage: DBSystemMessage = {
        type: "system",
        message_type: "invalid-token-retry",
        parts: [],
        timestamp: new Date().toISOString(),
      };

      // Ensure appendMessages is an array before pushing
      if (!threadChatUpdates.appendMessages) {
        threadChatUpdates.appendMessages = [];
      }
      threadChatUpdates.appendMessages.push(invalidTokenRetryMessage);

      // Create a "Continue" message to restart the agent
      const continueMessage: DBUserMessage = {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Continue" }],
        timestamp: new Date().toISOString(),
      };

      // Queue the Continue message to be processed after the thread update
      threadChatUpdates.appendQueuedMessages = [continueMessage];

      // Clear the error since we've handled it with retry
      threadChatUpdates.errorMessage = null;
      threadChatUpdates.errorMessageInfo = null;

      // Mark that we've recovered from the error and the thread is done
      isError = false;
      isOAuthTokenRevoked = false;
      isDone = true; // Mark as done so the thread completes normally

      getPostHogServer().capture({
        distinctId: userId,
        event: "oauth_token_revoked_retry",
        properties: {
          threadId,
        },
      });
    }
  }

  // Handle SDLC-aware error recovery: auto-retry generic errors during active SDLC phases.
  // This variable is hoisted so the follow-up recovery block below can reuse it
  // without a duplicate DB call.
  let sdlcLoopForErrorRecovery:
    | Awaited<ReturnType<typeof getActiveSdlcLoopForThread>>
    | undefined;
  if (isError && !isRateLimited && !isPromptTooLong && !isOAuthTokenRevoked) {
    try {
      sdlcLoopForErrorRecovery = await getActiveSdlcLoopForThread({
        db,
        userId,
        threadId,
      });
      const activeSdlcLoop = sdlcLoopForErrorRecovery;

      const failureCategory = classifyDaemonEventError(customErrorMessage);

      if (activeSdlcLoop && SDLC_AUTO_RETRY_PHASES.has(activeSdlcLoop.state)) {
        console.log(
          `SDLC error recovery: active loop in phase "${activeSdlcLoop.state}", failureCategory="${failureCategory}", checking for retry`,
          { threadId, threadChatId: threadChat.id, failureCategory },
        );

        const retryDecision = await evaluateRetryDecision({
          threadChatId: threadChat.id,
          failureCategory,
        });

        if (!retryDecision.shouldRetry) {
          console.log(
            `SDLC error retry denied: ${retryDecision.reason}, action="${retryDecision.action}", attempt=${retryDecision.attempt}/${retryDecision.maxAttempts}`,
            { threadId, threadChatId: threadChat.id, failureCategory },
          );
        } else {
          console.log(
            `SDLC error retry approved: action="${retryDecision.action}", attempt=${retryDecision.attempt}/${retryDecision.maxAttempts}, backoffMs=${retryDecision.backoffMs}`,
            { threadId, threadChatId: threadChat.id, failureCategory },
          );

          // Add a system message about the retry
          const sdlcErrorRetryMessage: DBSystemMessage = {
            type: "system",
            message_type: "sdlc-error-retry",
            parts: [],
            timestamp: new Date().toISOString(),
          };

          if (!threadChatUpdates.appendMessages) {
            threadChatUpdates.appendMessages = [];
          }
          threadChatUpdates.appendMessages.push(sdlcErrorRetryMessage);

          // Queue a "Continue" message to restart the agent
          const continueMessage: DBUserMessage = {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Continue" }],
            timestamp: new Date().toISOString(),
          };
          threadChatUpdates.appendQueuedMessages = [continueMessage];

          // Clear the error since we've handled it with retry
          threadChatUpdates.errorMessage = null;
          threadChatUpdates.errorMessageInfo = null;

          // Force a fresh session to avoid stale session issues
          threadChatUpdates.sessionId = null;

          // Mark that we've recovered from the error and the thread is done
          isError = false;
          isDone = true;

          getPostHogServer().capture({
            distinctId: userId,
            event: "sdlc_error_retry",
            properties: {
              threadId,
              sdlcPhase: activeSdlcLoop.state,
              failureCategory,
              retryAction: retryDecision.action,
              attempt: retryDecision.attempt,
              maxAttempts: retryDecision.maxAttempts,
            },
          });
        }
      }
    } catch (sdlcLookupError) {
      console.error(
        "Delivery Loop error recovery lookup failed, falling through to normal error path",
        { threadId, error: sdlcLookupError },
      );
    }
  }

  // Emit Linear agent activities for linear-sourced threads (fn-2+).
  // NOTE: Placed after all auto-recovery blocks (auto-compact, OAuth retry) so that
  // isDone/isError reflect the post-recovery state.
  // Terminal activities are suppressed when the recovery path queued a "Continue"
  // (appendQueuedMessages) — in that case the session is continuing, not finishing.
  if (thread.sourceType === "linear-mention" && thread.sourceMetadata != null) {
    const linearMeta = thread.sourceMetadata as Extract<
      ThreadSourceMetadata,
      { type: "linear-mention" }
    >;
    if (!linearMeta.agentSessionId) {
      // Legacy fn-1 thread without agentSessionId — log and skip
      console.warn(
        "[handle-daemon-event] Skipping Linear activity: legacy fn-1 thread missing agentSessionId",
        { threadId },
      );
    } else {
      // Suppress terminal emissions when recovery queued a "Continue" (auto-compact,
      // OAuth retry). The session is continuing, not ending.
      const hasQueuedFollowUp =
        (threadChatUpdates.appendQueuedMessages?.length ?? 0) > 0;
      const effectivelyDone = isDone && !isError && !hasQueuedFollowUp;
      const effectivelyError = isError && !hasQueuedFollowUp;

      waitUntil(
        emitLinearActivitiesForDaemonEvent(linearMeta, messages, {
          isDone: effectivelyDone,
          isError: effectivelyError,
          customErrorMessage,
          costUsd,
        }),
      );
    }
  }

  // Check if we should skip checkpoint when done
  let shouldSkipCheckpoint = false;
  if (isDone && !isError) {
    // Source of truth is the thread setting
    shouldSkipCheckpoint = isStop || !!thread.disableGitCheckpointing;

    // Reset retry counter on successful completion so the next error cycle
    // starts fresh.
    resetRetryCounter(threadChat.id).catch((err) =>
      console.warn("Failed to reset retry counter", {
        threadChatId: threadChat.id,
        error: err,
      }),
    );
  }

  const { didUpdateStatus } = await updateThreadChatWithTransition({
    userId,
    threadId,
    threadChatId: threadChat.id,
    markAsUnread: isDone || isError,
    updates: { bootingSubstatus: null },
    chatUpdates: threadChatUpdates,
    eventType: isStop
      ? "assistant.message_stop"
      : isRateLimited && rateLimitResetTime
        ? "system.agent-rate-limit"
        : isError
          ? "assistant.message_error"
          : isDone && shouldSkipCheckpoint
            ? "assistant.message_done_skip_checkpoint"
            : isDone
              ? "assistant.message_done"
              : "assistant.message",
    rateLimitResetTime,
  });
  if (isThreadFinished && didUpdateStatus) {
    // TODO this should block queueing up new threads.
    waitUntil(
      handleThreadFinish({
        userId,
        threadId,
        threadChatId: threadChat.id,
        sandboxId: thread.codesandboxId!,
        statusBeforeUpdate: threadChat.status,
        isRateLimited,
        isError,
        shouldSkipCheckpoint,
        sourceType: thread.sourceType ?? null,
        sourceMetadata: thread.sourceMetadata ?? null,
        runId,
      }),
    );
  }
  return { success: true };
}

async function handleThreadFinish({
  userId,
  threadId,
  threadChatId,
  sandboxId,
  statusBeforeUpdate,
  isRateLimited,
  isError,
  shouldSkipCheckpoint,
  sourceType,
  sourceMetadata,
  runId,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  sandboxId: string;
  statusBeforeUpdate: ThreadStatus;
  isRateLimited: boolean;
  isError: boolean;
  shouldSkipCheckpoint: boolean;
  sourceType: string | null;
  sourceMetadata: ThreadSourceMetadata | null;
  runId: string | null;
}) {
  // Re-read current thread chat status. If SDLC self-dispatch already
  // transitioned to "working", bail — the sandbox must stay active.
  const currentChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId,
  });
  if (currentChat && ACTIVE_PROCESSING_STATUSES.has(currentChat.status)) {
    console.log("[handleThreadFinish] Thread already re-dispatched, skipping", {
      threadId,
      threadChatId,
      currentStatus: currentChat.status,
    });
    return;
  }

  // Deactivate the sandbox immediately so hibernation is never blocked,
  // even if Vercel kills the function before the rest of the cleanup runs.
  await setActiveThreadChat({
    sandboxId,
    threadChatId,
    isActive: false,
    runId,
  });

  // Update Linear agent session externalUrls on completion (fallback if webhook handler missed it).
  if (sourceType === "linear-mention" && sourceMetadata != null) {
    const linearMeta = sourceMetadata as Extract<
      ThreadSourceMetadata,
      { type: "linear-mention" }
    >;
    if (linearMeta.agentSessionId) {
      waitUntil(
        (async () => {
          try {
            const tokenResult = await refreshLinearTokenIfNeeded(
              linearMeta.organizationId,
              db,
            );
            if (tokenResult.status === "ok") {
              const taskUrl = `${publicAppUrl()}/task/${threadId}`;
              await updateAgentSession({
                sessionId: linearMeta.agentSessionId!,
                accessToken: tokenResult.accessToken,
                externalUrls: [{ label: "Terragon Task", url: taskUrl }],
              });
            }
          } catch (error) {
            console.error(
              "[handle-daemon-event] Failed to update Linear agent session externalUrls",
              { threadId, error },
            );
          }
        })(),
      );
    }
  }

  let shouldProcessFollowUpQueue = !isRateLimited && !isError;

  // Second-chance recovery: when the auto-retry above is exhausted (alreadyRetried=true)
  // and isError is still true, re-queue the actual review findings so the next agent run
  // has actionable context. This reuses sdlcLoopForErrorRecovery to avoid a duplicate DB call.
  // Note: sdlcLoopForErrorRecovery is only populated when the first block's guard
  // (!isPromptTooLong && !isOAuthTokenRevoked) was met, so this is implicitly safe
  // even though the outer guard here is broader.
  if (isError && !isRateLimited) {
    try {
      const activeSdlcLoop = sdlcLoopForErrorRecovery;
      if (activeSdlcLoop && activeSdlcLoop.state === "implementing") {
        if (!activeSdlcLoop.currentHeadSha) {
          console.warn(
            "Delivery Loop error recovery: loop is implementing but currentHeadSha is null, skipping finding re-queue",
            { threadId, loopId: activeSdlcLoop.id },
          );
        } else {
          const [deepFindings, carmackFindings] = await Promise.all([
            getUnresolvedBlockingDeepReviewFindings({
              db,
              loopId: activeSdlcLoop.id,
              headSha: activeSdlcLoop.currentHeadSha,
            }),
            getUnresolvedBlockingCarmackReviewFindings({
              db,
              loopId: activeSdlcLoop.id,
              headSha: activeSdlcLoop.currentHeadSha,
            }),
          ]);

          const details = [
            formatReviewFindings({
              label: "Deep review blocking findings",
              findings: deepFindings.map((f) => ({
                ...f,
                severity: f.severity ?? "high",
              })),
            }),
            formatReviewFindings({
              label: "Carmack review blocking findings",
              findings: carmackFindings.map((f) => ({
                ...f,
                severity: f.severity ?? "high",
              })),
            }),
          ].filter((s): s is string => Boolean(s));

          if (details.length > 0) {
            // queueSdlcFollowUpMessage calls queueFollowUpInternal which
            // already triggers maybeProcessFollowUpQueue when the thread
            // is in error/done state, so we don't need to set
            // shouldProcessFollowUpQueue here.
            await queueSdlcFollowUpMessage({
              userId,
              threadId,
              threadChatId,
              heading:
                "Delivery Loop review phase blocked. The previous agent run crashed. Fix all blocking Deep/Carmack findings, then signal phaseComplete: true again.",
              details,
            });

            console.log(
              "Delivery Loop error recovery: re-queued review findings for crashed implementing agent",
              {
                threadId,
                deepCount: deepFindings.length,
                carmackCount: carmackFindings.length,
              },
            );
          }
        }
      }
    } catch (sdlcQueueError) {
      console.error(
        "Delivery Loop follow-up queue recovery failed, falling through to normal error path",
        { threadId, error: sdlcQueueError },
      );
    }
  }

  if (shouldProcessFollowUpQueue) {
    const threadChat = await getThreadChat({
      db,
      threadId,
      threadChatId,
      userId,
    });
    if (!threadChat) {
      throw new Error("Thread chat not found");
    }
    shouldProcessFollowUpQueue = !!(
      threadChat.queuedMessages && threadChat.queuedMessages.length > 0
    );
  }
  if (shouldProcessFollowUpQueue) {
    waitUntil(
      maybeProcessFollowUpQueue({
        threadId,
        threadChatId,
        userId,
        runId,
      }),
    );
  } else {
    // If the thread was booting and was rate limited, skip checkpoint too since we've done nothing.
    const skipCheckpointForRateLimit =
      statusBeforeUpdate === "booting" && isRateLimited;
    const skipCheckpoint = shouldSkipCheckpoint || skipCheckpointForRateLimit;
    if (!skipCheckpoint) {
      waitUntil(checkpointThread({ threadId, threadChatId, userId }));
    }
    const queuedThreadChats = await getEligibleQueuedThreadChats({ userId });
    if (queuedThreadChats.length > 0) {
      waitUntil(internalPOST(`process-thread-queue/${userId}`));
    }
  }
}
