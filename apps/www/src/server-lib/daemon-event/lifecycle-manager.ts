import type { ThreadStatus } from "@terragon/shared";
import type { ThreadSourceMetadata } from "@terragon/shared/db/types";
import type { RouterDependencies } from "./types";

export async function handleThreadFinish(params: {
  deps: RouterDependencies;
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
  followUpRunId: string | null;
}): Promise<void> {
  const {
    deps,
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
    followUpRunId,
  } = params;

  const otherRunsActive = await deps.hasOtherActiveRuns({
    sandboxId,
    threadChatId,
    excludeRunId: runId,
  });
  if (otherRunsActive) {
    if (process.env.NODE_ENV !== "production") {
      console.log(
        "[handleThreadFinish] Other runs still active, skipping sandbox deactivation",
        {
          threadId,
          threadChatId,
          runId,
        },
      );
    }
    await deps.setActiveThreadChat({
      sandboxId,
      threadChatId,
      isActive: false,
      runId,
    });
    return;
  }

  await deps.setActiveThreadChat({
    sandboxId,
    threadChatId,
    isActive: false,
    runId,
  });

  // Update Linear agent session externalUrls on completion
  if (sourceType === "linear-mention" && sourceMetadata != null) {
    const linearMeta = sourceMetadata as Extract<
      ThreadSourceMetadata,
      { type: "linear-mention" }
    >;
    if (linearMeta.agentSessionId) {
      const { waitUntil } = await import("@vercel/functions");
      const db = (await import("@/lib/db")).db;
      waitUntil(
        (async () => {
          try {
            const tokenResult = await deps.refreshLinearTokenIfNeeded(
              linearMeta.organizationId,
              db,
            );
            if (tokenResult.status === "ok") {
              const threadData = await deps.getThreadMinimal({
                db,
                threadId,
                userId,
              });
              if (threadData?.githubPRNumber && threadData.githubRepoFullName) {
                const prUrl = `https://github.com/${threadData.githubRepoFullName}/pull/${threadData.githubPRNumber}`;
                const addedExternalUrls: Parameters<
                  typeof deps.updateAgentSession
                >[0]["addedExternalUrls"] = [
                  { label: "Pull Request", url: prUrl },
                ];
                await deps.updateAgentSession({
                  sessionId: linearMeta.agentSessionId!,
                  accessToken: tokenResult.accessToken,
                  addedExternalUrls,
                });
              }
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

  if (shouldProcessFollowUpQueue) {
    try {
      const threadChat = await deps.getThreadChat({
        db: (await import("@/lib/db")).db,
        threadId,
        threadChatId,
        userId,
      });
      if (!threadChat) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            "[handleThreadFinish] Thread chat not found, skipping follow-up queue",
            { threadId, threadChatId },
          );
        }
        shouldProcessFollowUpQueue = false;
      } else {
        shouldProcessFollowUpQueue = !!(
          threadChat.queuedMessages && threadChat.queuedMessages.length > 0
        );
      }
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[handleThreadFinish] Failed to get thread chat, skipping follow-up queue",
          { threadId, threadChatId, err },
        );
      }
      shouldProcessFollowUpQueue = false;
    }
  }
  if (shouldProcessFollowUpQueue) {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(
      deps
        .maybeProcessFollowUpQueue({
          threadId,
          threadChatId,
          userId,
          runId: followUpRunId,
        })
        .catch((err: unknown) => {
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              "[handleThreadFinish] Follow-up queue processing failed",
              { threadId, threadChatId, err },
            );
          }
        }),
    );
  } else {
    const skipCheckpointForRateLimit =
      statusBeforeUpdate === "booting" && isRateLimited;
    const skipCheckpoint = shouldSkipCheckpoint || skipCheckpointForRateLimit;
    if (!skipCheckpoint) {
      const { waitUntil } = await import("@vercel/functions");
      waitUntil(
        deps
          .checkpointThread({ threadId, threadChatId, userId })
          .catch((err: unknown) => {
            if (process.env.NODE_ENV !== "production") {
              console.warn("[handleThreadFinish] Checkpoint failed", {
                threadId,
                threadChatId,
                err,
              });
            }
          }),
      );
    }
    const queuedThreadChats = await deps.getEligibleQueuedThreadChats({
      userId,
    });
    if (queuedThreadChats.length > 0) {
      const { waitUntil } = await import("@vercel/functions");
      waitUntil(
        deps
          .internalPOST(`process-thread-queue/${userId}`)
          .catch((err: unknown) => {
            if (process.env.NODE_ENV !== "production") {
              console.warn(
                "[handleThreadFinish] Queue processing POST failed",
                { userId, err },
              );
            }
          }),
      );
    }
  }
}

export function buildInterruptedToolResultMessages({
  openToolCalls,
  interruptionReason,
}: {
  openToolCalls: { toolCallId: string; parentToolUseId: string | null }[];
  interruptionReason: "user" | "error";
}): import("@terragon/shared").DBMessage[] {
  const interruptionMessage =
    interruptionReason === "error"
      ? "Tool execution interrupted by error"
      : "Tool execution interrupted by user";

  return openToolCalls.map((toolCall) => ({
    type: "tool-result" as const,
    id: toolCall.toolCallId,
    is_error: true,
    parent_tool_use_id: toolCall.parentToolUseId,
    result: interruptionMessage,
  }));
}
