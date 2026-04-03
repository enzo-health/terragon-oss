import { db } from "@/lib/db";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { getSlashCommandOrNull } from "@/agent/slash-command-handler";
import { startAgentMessage } from "@/agent/msg/startAgentMessage";
import { getLastUserMessageModel } from "@/lib/db-message-helpers";
import { getDefaultModelForAgent } from "@terragon/agent/utils";
import {
  getThreadChat,
  getThreadMinimal,
} from "@terragon/shared/model/threads";
import {
  getAgentRunContextByRunId,
  getLatestAgentRunContextForThreadChat,
} from "@terragon/shared/model/agent-run-context";
import { scheduleFollowUpRetryJob } from "@/server-lib/delivery-loop/retry-jobs";
import type {
  DBMessage,
  DBSystemMessage,
  DBUserMessage,
} from "@terragon/shared";

const ACTIVE_AGENT_RUN_STATUSES = new Set([
  "pending",
  "dispatched",
  "processing",
]);
const RECENT_TERMINAL_RUN_WINDOW_MS = 120_000;

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
    let dispatchLaunched = false;
    try {
      const latestRunContext = await getLatestAgentRunContextForThreadChat({
        db,
        userId,
        threadId,
        threadChatId,
      });
      if (latestRunContext) {
        if (ACTIVE_AGENT_RUN_STATUSES.has(latestRunContext.status)) {
          dispatchLaunched = true;
        } else {
          const updatedAt = latestRunContext.updatedAt?.getTime() ?? 0;
          dispatchLaunched =
            Date.now() - updatedAt <= RECENT_TERMINAL_RUN_WINDOW_MS;
        }
      }
    } catch (runContextError) {
      console.warn(
        "Failed to infer launch from latest run context during stale busy CAS",
        { threadId, threadChatId, runContextError },
      );
    }
    console.warn(
      "Skipping follow-up dispatch after noop status transition; chat is already active",
      { threadId, threadChatId, status: latestThreadChat.status },
    );
    return {
      processed: false,
      dispatchLaunched,
      reason: "stale_cas_busy",
    };
  }
  if (latestThreadChat?.status === "scheduled") {
    console.warn(
      "Skipping follow-up dispatch after noop status transition; chat remains scheduled",
      { threadId, threadChatId, status: latestThreadChat.status },
    );
    return {
      processed: false,
      dispatchLaunched: false,
      reason: "invalid_event",
    };
  }
  if (latestThreadChat) {
    console.warn(
      "Skipping follow-up dispatch after noop status transition; state changed",
      { threadId, threadChatId, status: latestThreadChat.status },
    );
  }
  return {
    processed: false,
    dispatchLaunched: false,
    reason: "stale_cas",
  };
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
  dispatchLaunched: boolean;
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
    | "dispatch_not_started"
    | "dispatch_retry_scheduled"
    | "dispatch_retry_persistence_failed"
    | "dispatch_retry_exhausted";
  retryCount?: number;
  maxRetries?: number;
};

type RetryPersistenceOwner =
  | "follow-up"
  | "startAgentMessage"
  | "process-follow-up-queue";

function retryDelayMsForAttempt(dispatchAttempt: number): number {
  return (
    FOLLOW_UP_RETRY_BASE_DELAY_MS *
    2 ** Math.max(0, Math.trunc(dispatchAttempt) - 1)
  );
}

export async function ensureDispatchRetryPersistenceOwnership({
  owner,
  userId,
  threadId,
  threadChatId,
  result,
}: {
  owner: RetryPersistenceOwner;
  userId: string;
  threadId: string;
  threadChatId: string;
  result: FollowUpQueueProcessingResult;
}): Promise<FollowUpQueueProcessingResult> {
  if (result.reason !== "dispatch_retry_persistence_failed") {
    return result;
  }

  const retryCount = Math.max(1, result.retryCount ?? 1);
  const maxRetries = result.maxRetries ?? MAX_FOLLOW_UP_RETRIES;
  const runAt = new Date(Date.now() + retryDelayMsForAttempt(retryCount));

  try {
    await scheduleFollowUpRetryJob({
      userId,
      threadId,
      threadChatId,
      dispatchAttempt: retryCount,
      deferCount: 0,
      runAt,
    });
    console.warn("Recovered follow-up retry persistence via owner fallback", {
      owner,
      threadId,
      threadChatId,
      retryCount,
      runAt: runAt.toISOString(),
    });
    return {
      processed: false,
      dispatchLaunched: false,
      reason: "dispatch_retry_scheduled",
      retryCount,
      maxRetries,
    };
  } catch (fallbackError) {
    console.error("Follow-up retry persistence fallback failed", {
      owner,
      threadId,
      threadChatId,
      retryCount,
      fallbackError,
    });
    return {
      processed: false,
      dispatchLaunched: false,
      reason: "dispatch_retry_persistence_failed",
      retryCount,
      maxRetries,
    };
  }
}

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
  bypassBusyCheck = false,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  runId?: string | null;
  /** When true, skip the stale-CAS busy guard so the delivery loop can
   *  dispatch a new run even when the threadChat is still in an active status
   *  from a prior run that has logically completed. */
  bypassBusyCheck?: boolean;
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
  const thread = await getThreadMinimal({
    db,
    threadId,
    userId,
  });
  const threadBranchName = thread?.branchName ?? undefined;
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
      return {
        processed: false,
        dispatchLaunched: false,
        reason: "missing_run_context",
      };
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
      return {
        processed: false,
        dispatchLaunched: false,
        reason: "run_context_mismatch",
      };
    }
    if (runContext.status !== "completed" && runContext.status !== "failed") {
      console.log("Skipping follow-up queue: run not terminal yet", {
        threadId,
        threadChatId,
        runId,
        runStatus: runContext.status,
      });
      const hasQueuedMessages = !!(
        threadChat?.queuedMessages && threadChat.queuedMessages.length > 0
      );
      if (hasQueuedMessages) {
        const retryCount = 1;
        const runAt = new Date(Date.now() + retryDelayMsForAttempt(retryCount));
        try {
          await scheduleFollowUpRetryJob({
            userId,
            threadId,
            threadChatId,
            dispatchAttempt: retryCount,
            deferCount: 0,
            runAt,
          });
          return {
            processed: false,
            dispatchLaunched: false,
            reason: "dispatch_retry_scheduled",
            retryCount,
            maxRetries: MAX_FOLLOW_UP_RETRIES,
          };
        } catch (retryError) {
          console.error(
            "Failed to persist retry while waiting for terminal run status",
            {
              threadId,
              threadChatId,
              runId,
              retryError,
            },
          );
          return {
            processed: false,
            dispatchLaunched: false,
            reason: "dispatch_retry_persistence_failed",
            retryCount,
            maxRetries: MAX_FOLLOW_UP_RETRIES,
          };
        }
      }
      return {
        processed: false,
        dispatchLaunched: false,
        reason: "run_not_terminal",
      };
    }
  }
  if (!threadChat) {
    console.warn("Skipping follow-up queue: thread chat not found", {
      threadId,
      threadChatId,
    });
    return {
      processed: false,
      dispatchLaunched: false,
      reason: "thread_chat_not_found",
    };
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
    return {
      processed: false,
      dispatchLaunched: false,
      reason: "agent_rate_limited",
    };
  }
  if (threadChat.status === "scheduled") {
    console.log("Skipping follow-up queue processing: chat is scheduled", {
      threadId,
      threadChatId,
    });
    return {
      processed: false,
      dispatchLaunched: false,
      reason: "scheduled_not_runnable",
    };
  }
  if (!threadChat.queuedMessages || threadChat.queuedMessages.length === 0) {
    return {
      processed: false,
      dispatchLaunched: false,
      reason: "no_queued_messages",
    };
  }
  console.log("Processing queued follow up messages on thread", {
    threadId,
    threadChatId: threadChat.id,
  });
  const queuedMessagesSnapshot = [...threadChat.queuedMessages];

  // Slash commands must be processed standalone. We intentionally scan the queue
  // instead of requiring index 0 so delayed/racy queue writes still route slash
  // commands through the deterministic slash handler path.
  const slashCommandIndex = threadChat.queuedMessages.findIndex(
    (queuedMessage) => !!getSlashCommandOrNull(queuedMessage),
  );
  if (slashCommandIndex !== -1) {
    const slashCommandMessage = threadChat.queuedMessages[slashCommandIndex]!;
    const restQueuedMessages = threadChat.queuedMessages.filter(
      (_, index) => index !== slashCommandIndex,
    );

    // Remove the slash command from the queued messages.
    const { didUpdateStatus } = await updateThreadChatWithTransition({
      userId,
      threadId,
      threadChatId: threadChatId,
      eventType: "user.message",
      chatUpdates: {
        replaceQueuedMessages: restQueuedMessages,
      },
      requireStatusTransitionForChatUpdates: !bypassBusyCheck,
    });
    if (!didUpdateStatus && !bypassBusyCheck) {
      const noopResult = await checkNoopBusy({
        threadId,
        threadChatId,
        userId,
      });
      if (noopResult) return noopResult;
    }
    const messageWithModel = {
      ...slashCommandMessage,
      model:
        slashCommandMessage.model ??
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
      const result = await startAgentMessage({
        db,
        userId,
        message: messageWithModel,
        threadId,
        threadChatId,
        isNewThread: false,
        createNewBranch: false,
        branchName: threadBranchName,
      });
      return {
        processed: true,
        dispatchLaunched: result.dispatchLaunched,
        reason: "dispatch_started_slash",
      };
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
      return ensureDispatchRetryPersistenceOwnership({
        owner: "process-follow-up-queue",
        userId,
        threadId,
        threadChatId,
        result: {
          processed: false,
          dispatchLaunched: false,
          reason: failureReason,
          retryCount: failure.retriesUsed,
          maxRetries: MAX_FOLLOW_UP_RETRIES,
        },
      });
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
    requireStatusTransitionForChatUpdates: !bypassBusyCheck,
  });
  if (!didUpdateStatus && !bypassBusyCheck) {
    const noopResult = await checkNoopBusy({ threadId, threadChatId, userId });
    if (noopResult) return noopResult;
  }
  console.log("Processing follow-up", {
    threadId,
    threadChatId,
    queuedMessageCount: threadChat.queuedMessages?.length ?? 0,
  });
  try {
    const result = await startAgentMessage({
      db,
      userId,
      threadId,
      threadChatId,
      isNewThread: false,
      createNewBranch: false,
      branchName: threadBranchName,
    });
    if (result.dispatchLaunched) {
      return {
        processed: true,
        dispatchLaunched: true,
        reason: "dispatch_started_batch",
      };
    }
    const retryCount = 1;
    const runAt = new Date(Date.now() + retryDelayMsForAttempt(retryCount));
    try {
      await scheduleFollowUpRetryJob({
        userId,
        threadId,
        threadChatId,
        dispatchAttempt: retryCount,
        deferCount: 0,
        runAt,
      });
      return {
        processed: false,
        dispatchLaunched: false,
        reason: "dispatch_retry_scheduled",
        retryCount,
        maxRetries: MAX_FOLLOW_UP_RETRIES,
      };
    } catch (retryError) {
      console.error("Failed to persist retry after dispatch did not launch", {
        threadId,
        threadChatId,
        retryError,
      });
      return {
        processed: false,
        dispatchLaunched: false,
        reason: "dispatch_retry_persistence_failed",
        retryCount,
        maxRetries: MAX_FOLLOW_UP_RETRIES,
      };
    }
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
    return ensureDispatchRetryPersistenceOwnership({
      owner: "process-follow-up-queue",
      userId,
      threadId,
      threadChatId,
      result: {
        processed: false,
        dispatchLaunched: false,
        reason: failureReason,
        retryCount: failure.retriesUsed,
        maxRetries: MAX_FOLLOW_UP_RETRIES,
      },
    });
  }
}
