import { db } from "@/lib/db";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { getSlashCommandOrNull } from "@/agent/slash-command-handler";
import { startAgentMessage } from "@/agent/msg/startAgentMessage";
import { getLastUserMessageModel } from "@/lib/db-message-helpers";
import { getDefaultModelForAgent } from "@terragon/agent/utils";
import { getThreadChat } from "@terragon/shared/model/threads";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { scheduleFollowUpRetryJob } from "@/server-lib/delivery-loop/retry-jobs";
import type {
  DBMessage,
  DBSystemMessage,
  DBUserMessage,
} from "@terragon/shared";

async function checkNoopBusy({
  threadId,
  threadChatId,
  userId,
}: {
  threadId: string;
  threadChatId: string;
  userId: string;
}): Promise<FollowUpQueueProcessingResult | null> {
  const latestThreadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId,
  });
  if (
    latestThreadChat &&
    FOLLOW_UP_ACTIVE_PROCESSING_STATUSES.has(latestThreadChat.status)
  ) {
    console.warn(
      "Skipping follow-up dispatch after noop status transition; chat is already active",
      { threadId, threadChatId, status: latestThreadChat.status },
    );
    return { processed: false, reason: "stale_cas_busy" };
  }
  if (latestThreadChat?.status === "scheduled") {
    console.warn(
      "Skipping follow-up dispatch after noop status transition; chat remains scheduled",
      { threadId, threadChatId, status: latestThreadChat.status },
    );
    return { processed: false, reason: "invalid_event" };
  }
  if (latestThreadChat) {
    console.warn(
      "Skipping follow-up dispatch after noop status transition; state changed",
      { threadId, threadChatId, status: latestThreadChat.status },
    );
  }
  return { processed: false, reason: "stale_cas" };
}

const MAX_FOLLOW_UP_RETRIES = 3;
const FOLLOW_UP_RETRY_BASE_DELAY_MS = 2_000;
const FOLLOW_UP_ACTIVE_PROCESSING_STATUSES = new Set([
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

export type FollowUpQueueProcessingResult = {
  processed: boolean;
  reason:
    | "missing_run_context"
    | "run_context_mismatch"
    | "run_not_terminal"
    | "thread_chat_not_found"
    | "agent_rate_limited"
    | "no_queued_messages"
    | "scheduled_not_runnable"
    | "stale_cas"
    | "stale_cas_busy"
    | "invalid_event"
    | "dispatch_started_slash"
    | "dispatch_started_batch"
    | "dispatch_retry_scheduled"
    | "dispatch_retry_persistence_failed"
    | "dispatch_retry_exhausted";
  retryCount?: number;
  maxRetries?: number;
};

/**
 * Shared retry handler for follow-up processing failures.
 * Counts existing retry markers, clears queue on max retries, or appends a retry marker.
 */
function formatFollowUpError(error: unknown): string {
  if (error instanceof Error) {
    const parts = [error.message];
    if (error.stack) {
      // Include first 3 stack frames for context
      const frames = error.stack.split("\n").slice(1, 4).join("\n");
      parts.push(frames);
    }
    return parts.join("\n");
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function handleFollowUpFailure({
  userId,
  threadId,
  threadChatId,
  messages,
  queuedMessagesForRetry,
  error,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  messages: DBMessage[] | null;
  queuedMessagesForRetry: DBUserMessage[];
  error: unknown;
}): Promise<{
  retriesUsed: number;
  exhausted: boolean;
  retryAt: Date | null;
  retryPersisted: boolean;
}> {
  const formattedError = formatFollowUpError(error);
  console.error("handleFollowUpFailure invoked", {
    threadId,
    threadChatId,
    errorDetail: formattedError,
  });

  const existingRetries = (messages ?? []).filter(
    (m): m is DBSystemMessage =>
      m.type === "system" && m.message_type === "follow-up-retry-failed",
  ).length;
  const retriesUsed = existingRetries + 1;
  const exhausted = existingRetries >= MAX_FOLLOW_UP_RETRIES - 1;
  const retryDelayMs = FOLLOW_UP_RETRY_BASE_DELAY_MS * 2 ** existingRetries;
  const retryAt = exhausted ? null : new Date(Date.now() + retryDelayMs);
  let retryPersisted = exhausted;

  try {
    if (existingRetries >= MAX_FOLLOW_UP_RETRIES - 1) {
      await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId,
        eventType: "system.error",
        chatUpdates: {
          replaceQueuedMessages: [],
          errorMessage: "agent-generic-error",
          errorMessageInfo: `Follow-up failed ${existingRetries + 1} times: ${formattedError}`,
          appendMessages: [
            {
              type: "system",
              message_type: "follow-up-retry-failed",
              parts: [
                {
                  type: "text" as const,
                  text: "Follow-up processing failed. Queue cleared.",
                },
              ],
              timestamp: new Date().toISOString(),
            },
          ],
        },
      });
    } else {
      if (!retryAt) {
        throw new Error(
          "Retry scheduling requires a retryAt timestamp when retries are not exhausted",
        );
      }
      await scheduleFollowUpRetryJob({
        userId,
        threadId,
        threadChatId,
        dispatchAttempt: retriesUsed,
        deferCount: 0,
        runAt: retryAt,
      });
      retryPersisted = true;
      await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId,
        eventType: "system.error",
        chatUpdates: {
          replaceQueuedMessages: queuedMessagesForRetry,
          appendMessages: [
            {
              type: "system",
              message_type: "follow-up-retry-failed",
              parts: [
                {
                  type: "text" as const,
                  text: `Follow-up attempt ${retriesUsed} of ${MAX_FOLLOW_UP_RETRIES} failed. Retrying in ~${Math.ceil(retryDelayMs / 1000)}s...`,
                },
              ],
              timestamp: new Date().toISOString(),
            },
          ],
        },
      });
    }
    return {
      retriesUsed,
      exhausted,
      retryAt,
      retryPersisted,
    };
  } catch (updateError) {
    console.error("Failed to record follow-up retry failure", {
      threadId,
      threadChatId,
      updateError,
    });
    return {
      retriesUsed,
      exhausted,
      retryAt,
      retryPersisted,
    };
  }
}

export async function maybeProcessFollowUpQueue({
  userId,
  threadId,
  threadChatId,
  runId = null,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  runId?: string | null;
}): Promise<FollowUpQueueProcessingResult> {
  console.log("Checking if we have queued follow up messages", {
    threadId,
    threadChatId,
  });
  const threadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId,
  });
  if (runId) {
    const runContext = await getAgentRunContextByRunId({
      db,
      runId,
      userId,
    });
    if (!runContext) {
      console.warn("Skipping follow-up queue: missing run context", {
        threadId,
        threadChatId,
        runId,
      });
      return { processed: false, reason: "missing_run_context" };
    }
    if (
      runContext.threadId !== threadId ||
      runContext.threadChatId !== threadChatId
    ) {
      console.warn(
        "Skipping follow-up queue: run context does not match chat",
        {
          threadId,
          threadChatId,
          runId,
          runContextThreadId: runContext.threadId,
          runContextThreadChatId: runContext.threadChatId,
        },
      );
      return { processed: false, reason: "run_context_mismatch" };
    }
    if (runContext.status !== "completed" && runContext.status !== "failed") {
      console.log("Skipping follow-up queue: run not terminal yet", {
        threadId,
        threadChatId,
        runId,
        runStatus: runContext.status,
      });
      return { processed: false, reason: "run_not_terminal" };
    }
  }
  if (!threadChat) {
    console.warn("Skipping follow-up queue: thread chat not found", {
      threadId,
      threadChatId,
    });
    return { processed: false, reason: "thread_chat_not_found" };
  }
  // Don't process follow up messages if the thread is rate limited by the agent.
  if (threadChat.status === "queued-agent-rate-limit") {
    console.log(
      `Skipping follow-up queue processing for thread - agent rate limited`,
      {
        threadId,
        threadChatId: threadChat.id,
      },
    );
    return { processed: false, reason: "agent_rate_limited" };
  }
  if (threadChat.status === "scheduled") {
    console.log("Skipping follow-up queue processing: chat is scheduled", {
      threadId,
      threadChatId,
    });
    return { processed: false, reason: "scheduled_not_runnable" };
  }
  if (!threadChat.queuedMessages || threadChat.queuedMessages.length === 0) {
    return { processed: false, reason: "no_queued_messages" };
  }
  console.log("Processing queued follow up messages on thread", {
    threadId,
    threadChatId: threadChat.id,
  });
  const queuedMessagesSnapshot = [...threadChat.queuedMessages];

  // If the first queued message is a slash command, send it to the agent separately.
  // TODO: If there's slash commands in side of the queued messages and the slash command
  // is not first, things still do not work great since we concat all messages into one prompt
  // and send it to the agent inside of startAgentMessage.
  const firstQueuedMessage = threadChat.queuedMessages[0]!;
  if (getSlashCommandOrNull(firstQueuedMessage)) {
    const restQueuedMessages = threadChat.queuedMessages.slice(1);
    // Remove the slash command from the queued messages.
    const { didUpdateStatus } = await updateThreadChatWithTransition({
      userId,
      threadId,
      threadChatId: threadChatId,
      eventType: "user.message",
      chatUpdates: {
        replaceQueuedMessages: restQueuedMessages,
      },
      requireStatusTransitionForChatUpdates: true,
    });
    if (!didUpdateStatus) {
      const noopResult = await checkNoopBusy({
        threadId,
        threadChatId,
        userId,
      });
      if (noopResult) return noopResult;
    }
    const messageWithModel = {
      ...firstQueuedMessage,
      model:
        firstQueuedMessage.model ??
        getLastUserMessageModel(threadChat.messages ?? []) ??
        getDefaultModelForAgent({
          agent: threadChat.agent,
          agentVersion: threadChat.agentVersion,
        }),
    };
    console.log("Processing follow-up", {
      threadId,
      threadChatId,
      queuedMessageCount: threadChat.queuedMessages?.length ?? 0,
    });
    try {
      await startAgentMessage({
        db,
        userId,
        message: messageWithModel,
        threadId,
        threadChatId,
        isNewThread: false,
      });
      return { processed: true, reason: "dispatch_started_slash" };
    } catch (error) {
      console.error("Follow-up processing failed", {
        threadId,
        threadChatId,
        error,
      });
      const failure = await handleFollowUpFailure({
        userId,
        threadId,
        threadChatId,
        messages: threadChat.messages,
        queuedMessagesForRetry: queuedMessagesSnapshot,
        error,
      });
      let failureReason: FollowUpQueueProcessingResult["reason"] =
        "dispatch_retry_persistence_failed";
      if (failure.exhausted) {
        failureReason = "dispatch_retry_exhausted";
      } else if (failure.retryPersisted) {
        failureReason = "dispatch_retry_scheduled";
      }
      return {
        processed: false,
        reason: failureReason,
        retryCount: failure.retriesUsed,
        maxRetries: MAX_FOLLOW_UP_RETRIES,
      };
    }
  }

  const { didUpdateStatus } = await updateThreadChatWithTransition({
    userId,
    threadId,
    threadChatId,
    eventType: "user.message",
    chatUpdates: {
      appendAndResetQueuedMessages: true,
    },
    requireStatusTransitionForChatUpdates: true,
  });
  if (!didUpdateStatus) {
    const noopResult = await checkNoopBusy({ threadId, threadChatId, userId });
    if (noopResult) return noopResult;
  }
  console.log("Processing follow-up", {
    threadId,
    threadChatId,
    queuedMessageCount: threadChat.queuedMessages?.length ?? 0,
  });
  try {
    await startAgentMessage({
      db,
      userId,
      threadId,
      threadChatId,
      isNewThread: false,
    });
    return { processed: true, reason: "dispatch_started_batch" };
  } catch (error) {
    console.error("Follow-up processing failed", {
      threadId,
      threadChatId,
      error,
    });
    const failure = await handleFollowUpFailure({
      userId,
      threadId,
      threadChatId,
      messages: threadChat.messages,
      queuedMessagesForRetry: queuedMessagesSnapshot,
      error,
    });
    let failureReason: FollowUpQueueProcessingResult["reason"] =
      "dispatch_retry_persistence_failed";
    if (failure.exhausted) {
      failureReason = "dispatch_retry_exhausted";
    } else if (failure.retryPersisted) {
      failureReason = "dispatch_retry_scheduled";
    }
    return {
      processed: false,
      reason: failureReason,
      retryCount: failure.retriesUsed,
      maxRetries: MAX_FOLLOW_UP_RETRIES,
    };
  }
}
