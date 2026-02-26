import { toDBMessage } from "@/agent/msg/toDBMessage";
import { readSandboxHeadSha } from "@/agent/sandbox";
import { getPendingToolCallErrorMessages } from "@/lib/db-message-helpers";
import { db } from "@/lib/db";
import { ClaudeMessage } from "@terragon/daemon/shared";
import { redis } from "@/lib/redis";
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
} from "@terragon/shared/model/threads";
import {
  daemonEventQuarantine,
  threadRun,
  threadRunContext,
  threadUiValidation,
} from "@terragon/shared/db/schema";
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
import { refreshLinearTokenIfNeeded } from "./linear-oauth";
import type { ThreadSourceMetadata } from "@terragon/shared/db/types";
import { publicAppUrl } from "@terragon/env/next-public";
import { type DaemonEventQuarantineReason } from "@terragon/shared/types/preview";
import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { updateRunLastAcceptedSeq } from "./run-context";
import {
  emitPreviewAccessDenied,
  emitPreviewMetric,
} from "./preview-observability";
import { r2Private } from "./r2";

const DAEMON_EVENT_DEDUPE_TTL_SECONDS = 24 * 60 * 60;
const QUARANTINE_PAYLOAD_PREFIX_BYTES = 2 * 1024;
const QUARANTINE_INLINE_MAX_BYTES = 16 * 1024;
const QUARANTINE_OFFLOAD_MAX_PER_MINUTE = 20;

function batchHasLikelyUiSignal(messages: ClaudeMessage[]): boolean {
  const uiFilePattern = /\.(tsx?|jsx?|css|scss|less|html)\b/i;
  for (const message of messages) {
    if (message.type !== "assistant" && message.type !== "user") {
      continue;
    }
    const content = message.message.content;
    if (typeof content === "string") {
      if (uiFilePattern.test(content)) {
        return true;
      }
      continue;
    }
    for (const part of content) {
      if (part.type === "text" && uiFilePattern.test(part.text ?? "")) {
        return true;
      }
    }
  }
  return false;
}

async function reserveDaemonEventId({
  runId,
  eventId,
}: {
  runId: string;
  eventId: string;
}): Promise<boolean> {
  const key = `terragon:v1:preview:daemon-event-id:${runId}:${eventId}`;
  const result = await redis.set(key, "1", {
    nx: true,
    ex: DAEMON_EVENT_DEDUPE_TTL_SECONDS,
  });
  return result === "OK";
}

async function shouldOffloadQuarantinePayload({
  repoFullName,
}: {
  repoFullName: string;
}): Promise<boolean> {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const key = `terragon:v1:preview:daemon-quarantine:offload:${repoFullName}:${minuteBucket}`;
  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, 120);
  }
  return current <= QUARANTINE_OFFLOAD_MAX_PER_MINUTE;
}

async function persistDaemonEventQuarantine({
  threadId,
  threadChatId,
  runIdOrNull,
  activeRunId,
  reason,
  payload,
  repoFullName,
}: {
  threadId: string;
  threadChatId: string;
  runIdOrNull: string | null;
  activeRunId: string | null;
  reason: DaemonEventQuarantineReason;
  payload: Record<string, unknown>;
  repoFullName: string;
}): Promise<void> {
  const serialized = JSON.stringify(payload);
  const payloadBuffer = Buffer.from(serialized);
  const payloadPrefix2k = payloadBuffer
    .subarray(0, QUARANTINE_PAYLOAD_PREFIX_BYTES)
    .toString("utf8");
  const payloadHash = createHash("sha256").update(payloadBuffer).digest("hex");

  let payloadR2Key: string | null = null;
  if (payloadBuffer.byteLength > QUARANTINE_INLINE_MAX_BYTES) {
    const shouldOffload = await shouldOffloadQuarantinePayload({
      repoFullName,
    });
    if (shouldOffload) {
      payloadR2Key = [
        "preview",
        "daemon-quarantine",
        threadId,
        new Date().toISOString().slice(0, 10),
        `${crypto.randomUUID()}.json`,
      ].join("/");
      await r2Private.uploadData({
        key: payloadR2Key,
        data: payloadBuffer,
        contentType: "application/json",
      });
    }
  }

  await db.insert(daemonEventQuarantine).values({
    threadId,
    threadChatId,
    runIdOrNull,
    activeRunId,
    reason,
    payloadHash,
    payloadPrefix2k,
    payloadR2Key: payloadR2Key ?? undefined,
  });
}

async function applyLegacyModeValidationOutcome({
  threadId,
  threadChatId,
  runId,
  messages,
}: {
  threadId: string;
  threadChatId: string;
  runId: string;
  messages: ClaudeMessage[];
}): Promise<void> {
  const likelyUiSignal = batchHasLikelyUiSignal(messages);
  const outcome = likelyUiSignal ? "inconclusive" : "not_required";
  const blockingReason = likelyUiSignal
    ? "Daemon event arrived without runId in legacy mode; UI validation is inconclusive."
    : null;

  await db
    .insert(threadUiValidation)
    .values({
      threadId,
      threadChatId,
      latestRunId: runId,
      uiValidationOutcome: outcome,
      blockingReason,
    })
    .onConflictDoUpdate({
      target: [threadUiValidation.threadId, threadUiValidation.threadChatId],
      set: {
        latestRunId: runId,
        uiValidationOutcome: outcome,
        blockingReason,
      },
    });
}

export async function handleDaemonEvent({
  messages,
  threadId,
  threadChatId,
  userId,
  timezone,
  contextUsage,
  payloadVersion = 1,
  runId = null,
  eventId = null,
  seq = null,
  endSha = null,
  traceId = crypto.randomUUID(),
}: {
  messages: ClaudeMessage[];
  threadId: string;
  threadChatId: string;
  userId: string;
  timezone: string;
  contextUsage: number | null;
  payloadVersion?: 1 | 2;
  runId?: string | null;
  eventId?: string | null;
  seq?: number | null;
  endSha?: string | null;
  traceId?: string;
}) {
  console.log(
    "Daemon event",
    "threadId",
    threadId,
    "threadChatId",
    threadChatId,
    "payloadVersion",
    payloadVersion,
    "runId",
    runId,
    "eventId",
    eventId,
    "seq",
    seq,
    "timezone",
    timezone,
    "messages",
    JSON.stringify(messages, null, 2),
  );
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

  const envelopePayload = {
    threadId,
    threadChatId,
    payloadVersion,
    runId,
    eventId,
    seq,
    endSha,
    timezone,
    messages,
  } satisfies Record<string, unknown>;

  const runContextRow = await db.query.threadRunContext.findFirst({
    where: and(
      eq(threadRunContext.threadId, threadId),
      eq(threadRunContext.threadChatId, threadChatId),
    ),
    columns: {
      activeRunId: true,
    },
  });

  const activeRun =
    runContextRow?.activeRunId == null
      ? null
      : await db.query.threadRun.findFirst({
          where: and(
            eq(threadRun.runId, runContextRow.activeRunId),
            eq(threadRun.threadId, threadId),
            eq(threadRun.threadChatId, threadChatId),
          ),
          columns: {
            runId: true,
            frozenFlagSnapshotJson: true,
            daemonPayloadVersion: true,
          },
        });

  const strictRunId = !!activeRun?.frozenFlagSnapshotJson?.daemonRunIdStrict;
  let resolvedRunId = runId;

  if (!resolvedRunId && activeRun?.runId) {
    if (strictRunId) {
      await persistDaemonEventQuarantine({
        threadId,
        threadChatId,
        runIdOrNull: null,
        activeRunId: activeRun.runId,
        reason: "missing_run_id",
        payload: envelopePayload,
        repoFullName: thread.githubRepoFullName,
      });
      emitPreviewMetric({
        metricName: "preview.strict_mismatch",
        base: {
          origin: "daemon_event",
          traceId,
          threadId,
          threadChatId,
          runId: activeRun.runId,
        },
        dimensions: {
          userId,
          repoFullName: thread.githubRepoFullName,
          sandboxProvider: thread.sandboxProvider,
        },
        properties: {
          reason: "missing_run_id",
          strictMode: true,
        },
      });
      emitPreviewAccessDenied({
        reason: "binding_mismatch",
        status: 403,
        base: {
          origin: "daemon_event",
          traceId,
          threadId,
          threadChatId,
          runId: activeRun.runId,
        },
        dimensions: {
          userId,
          repoFullName: thread.githubRepoFullName,
          sandboxProvider: thread.sandboxProvider,
        },
        properties: {
          reason: "missing_run_id",
        },
      });
      return { success: true, ackStatus: 202 as const };
    }

    resolvedRunId = activeRun.runId;
    await persistDaemonEventQuarantine({
      threadId,
      threadChatId,
      runIdOrNull: null,
      activeRunId: activeRun.runId,
      reason: "legacy_mode",
      payload: envelopePayload,
      repoFullName: thread.githubRepoFullName,
    });
    emitPreviewMetric({
      metricName: "preview.legacy_mode",
      base: {
        origin: "daemon_event",
        traceId,
        threadId,
        threadChatId,
        runId: activeRun.runId,
      },
      dimensions: {
        userId,
        repoFullName: thread.githubRepoFullName,
        sandboxProvider: thread.sandboxProvider,
      },
      properties: {
        reason: "legacy_mode",
      },
    });
    await applyLegacyModeValidationOutcome({
      threadId,
      threadChatId,
      runId: activeRun.runId,
      messages,
    });
  }

  if (runId && activeRun?.runId && runId !== activeRun.runId) {
    await persistDaemonEventQuarantine({
      threadId,
      threadChatId,
      runIdOrNull: runId,
      activeRunId: activeRun.runId,
      reason: "mismatch",
      payload: envelopePayload,
      repoFullName: thread.githubRepoFullName,
    });
    emitPreviewMetric({
      metricName: "preview.strict_mismatch",
      base: {
        origin: "daemon_event",
        traceId,
        threadId,
        threadChatId,
        runId: activeRun.runId,
      },
      dimensions: {
        userId,
        repoFullName: thread.githubRepoFullName,
        sandboxProvider: thread.sandboxProvider,
      },
      properties: {
        reason: "mismatch",
        strictMode: strictRunId,
      },
    });
    if (strictRunId) {
      emitPreviewAccessDenied({
        reason: "binding_mismatch",
        status: 403,
        base: {
          origin: "daemon_event",
          traceId,
          threadId,
          threadChatId,
          runId: activeRun.runId,
        },
        dimensions: {
          userId,
          repoFullName: thread.githubRepoFullName,
          sandboxProvider: thread.sandboxProvider,
        },
        properties: {
          reason: "mismatch",
        },
      });
    }
    return { success: true, ackStatus: 202 as const };
  }

  if (
    resolvedRunId &&
    activeRun?.runId === resolvedRunId &&
    activeRun.daemonPayloadVersion !== null &&
    activeRun.daemonPayloadVersion !== payloadVersion
  ) {
    await persistDaemonEventQuarantine({
      threadId,
      threadChatId,
      runIdOrNull: resolvedRunId,
      activeRunId: activeRun.runId,
      reason: "payload_version_mismatch",
      payload: envelopePayload,
      repoFullName: thread.githubRepoFullName,
    });
    return { success: true, ackStatus: 202 as const };
  }

  if (
    payloadVersion === 2 &&
    resolvedRunId &&
    (!eventId || !Number.isInteger(seq) || (seq ?? 0) <= 0)
  ) {
    await persistDaemonEventQuarantine({
      threadId,
      threadChatId,
      runIdOrNull: resolvedRunId,
      activeRunId: activeRun?.runId ?? null,
      reason: "payload_version_mismatch",
      payload: envelopePayload,
      repoFullName: thread.githubRepoFullName,
    });
    return { success: true, ackStatus: 202 as const };
  }

  if (resolvedRunId && eventId) {
    const reserved = await reserveDaemonEventId({
      runId: resolvedRunId,
      eventId,
    });
    if (!reserved) {
      return { success: true, ackStatus: 202 as const };
    }
  }

  if (resolvedRunId && seq !== null) {
    const acceptedSeq = await updateRunLastAcceptedSeq({
      db,
      runId: resolvedRunId,
      nextSeq: seq,
    });
    if (!acceptedSeq) {
      return { success: true, ackStatus: 202 as const };
    }
  }

  if (
    resolvedRunId &&
    activeRun?.runId === resolvedRunId &&
    activeRun.daemonPayloadVersion === null
  ) {
    await db
      .update(threadRun)
      .set({
        daemonPayloadVersion: payloadVersion,
      })
      .where(
        and(
          eq(threadRun.runId, resolvedRunId),
          eq(threadRun.threadId, threadId),
          eq(threadRun.threadChatId, threadChatId),
          isNull(threadRun.daemonPayloadVersion),
        ),
      );
  }

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
  const isThreadFinished = isStop || isDone || isError;
  let forceWorkingTreeFallback = false;

  if (isThreadFinished && payloadVersion === 2 && resolvedRunId && !endSha) {
    await persistDaemonEventQuarantine({
      threadId,
      threadChatId,
      runIdOrNull: resolvedRunId,
      activeRunId: activeRun?.runId ?? null,
      reason: "missing_end_sha",
      payload: envelopePayload,
      repoFullName: thread.githubRepoFullName,
    });
    emitPreviewMetric({
      metricName: "preview.missing_end_sha",
      base: {
        origin: "daemon_event",
        traceId,
        threadId,
        threadChatId,
        runId: resolvedRunId,
      },
      dimensions: {
        userId,
        repoFullName: thread.githubRepoFullName,
        sandboxProvider: thread.sandboxProvider,
      },
      properties: {
        strictMode: strictRunId,
      },
    });
    return { success: true, ackStatus: 202 as const };
  }

  if (resolvedRunId) {
    const now = new Date();
    const terminalStatus = isError ? "failed" : "finished";
    let runEndShaToPersist: string | null = endSha;

    if (isThreadFinished && endSha) {
      const liveHeadSha = await readSandboxHeadSha({
        sandboxId: thread.codesandboxId,
        sandboxProvider: thread.sandboxProvider,
      });
      forceWorkingTreeFallback = !liveHeadSha || liveHeadSha !== endSha;
      if (forceWorkingTreeFallback) {
        runEndShaToPersist = null;
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .update(threadRun)
        .set({
          status: isThreadFinished ? terminalStatus : "running",
          ...(isThreadFinished ? { endedAt: now } : {}),
          ...(isThreadFinished && eventId ? { terminalEventId: eventId } : {}),
          ...(isThreadFinished ? { runEndSha: runEndShaToPersist } : {}),
        })
        .where(
          and(
            eq(threadRun.runId, resolvedRunId),
            eq(threadRun.threadId, threadId),
            eq(threadRun.threadChatId, threadChatId),
          ),
        );

      await tx
        .update(threadRunContext)
        .set({
          activeStatus: isThreadFinished ? terminalStatus : "running",
          activeUpdatedAt: now,
        })
        .where(
          and(
            eq(threadRunContext.threadId, threadId),
            eq(threadRunContext.threadChatId, threadChatId),
            eq(threadRunContext.activeRunId, resolvedRunId),
          ),
        );
    });
  }

  waitUntil(
    trackUsageEvents({
      userId,
      costUsd,
      agentDurationMs: durationMs,
    }),
  );
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
        forceWorkingTreeFallback,
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
        shouldSkipCheckpoint,
        sourceType: thread.sourceType ?? null,
        sourceMetadata: thread.sourceMetadata ?? null,
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
  shouldSkipCheckpoint,
  sourceType,
  sourceMetadata,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  sandboxId: string;
  statusBeforeUpdate: ThreadStatus;
  isRateLimited: boolean;
  shouldSkipCheckpoint: boolean;
  sourceType: string | null;
  sourceMetadata: ThreadSourceMetadata | null;
}) {
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

  let shouldProcessFollowUpQueue = !isRateLimited;
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
    waitUntil(maybeProcessFollowUpQueue({ threadId, threadChatId, userId }));
  } else {
    // If the thread was booting and was rate limited, skip checkpoint too since we've done nothing.
    const skipCheckpointForRateLimit =
      statusBeforeUpdate === "booting" && isRateLimited;
    const skipCheckpoint = shouldSkipCheckpoint || skipCheckpointForRateLimit;
    if (!skipCheckpoint) {
      waitUntil(checkpointThread({ threadId, threadChatId, userId }));
    }
    waitUntil(
      setActiveThreadChat({ sandboxId, threadChatId, isActive: false }),
    );
    const queuedThreadChats = await getEligibleQueuedThreadChats({ userId });
    if (queuedThreadChats.length > 0) {
      waitUntil(internalPOST(`process-thread-queue/${userId}`));
    }
  }
}
