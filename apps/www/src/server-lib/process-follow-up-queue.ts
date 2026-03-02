import { db } from "@/lib/db";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { getSlashCommandOrNull } from "@/agent/slash-command-handler";
import { startAgentMessage } from "@/agent/msg/startAgentMessage";
import { getLastUserMessageModel } from "@/lib/db-message-helpers";
import { getDefaultModelForAgent } from "@terragon/agent/utils";
import { getThreadChat } from "@terragon/shared/model/threads";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";

const MAX_FOLLOW_UP_RETRIES = 3;

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
}) {
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
      return;
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
      return;
    }
    if (
      runContext.status !== "completed" &&
      runContext.status !== "failed" &&
      runContext.status !== "stopped"
    ) {
      console.log("Skipping follow-up queue: run not terminal yet", {
        threadId,
        threadChatId,
        runId,
        runStatus: runContext.status,
      });
      return;
    }
  }
  if (!threadChat) {
    throw new Error("Thread chat not found");
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
    return;
  }
  if (!threadChat.queuedMessages || threadChat.queuedMessages.length === 0) {
    return;
  }
  console.log("Processing queued follow up messages on thread", {
    threadId,
    threadChatId: threadChat.id,
  });

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
    });
    if (!didUpdateStatus) {
      throw new Error("Failed to process follow up message");
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
    } catch (error) {
      console.error("Follow-up processing failed", {
        threadId,
        threadChatId,
        error,
      });

      const existingRetries = (threadChat.messages ?? []).filter(
        (m) =>
          m.type === "system" &&
          (m as { message_type: string }).message_type ===
            "follow-up-retry-failed",
      ).length;

      if (existingRetries >= MAX_FOLLOW_UP_RETRIES - 1) {
        await updateThreadChatWithTransition({
          userId,
          threadId,
          threadChatId,
          eventType: "system.error",
          chatUpdates: {
            replaceQueuedMessages: [],
            errorMessage: "agent-generic-error",
            errorMessageInfo: `Follow-up failed ${existingRetries + 1} times`,
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
        await updateThreadChatWithTransition({
          userId,
          threadId,
          threadChatId,
          eventType: "system.error",
          chatUpdates: {
            appendMessages: [
              {
                type: "system",
                message_type: "follow-up-retry-failed",
                parts: [
                  {
                    type: "text" as const,
                    text: `Follow-up attempt ${existingRetries + 1} failed: ${error instanceof Error ? error.message : "unknown"}`,
                  },
                ],
                timestamp: new Date().toISOString(),
              },
            ],
          },
        });
      }
    }
    return;
  }

  const { didUpdateStatus } = await updateThreadChatWithTransition({
    userId,
    threadId,
    threadChatId,
    eventType: "user.message",
    chatUpdates: {
      appendAndResetQueuedMessages: true,
    },
  });
  if (!didUpdateStatus) {
    throw new Error("Failed to process follow up message");
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
  } catch (error) {
    console.error("Follow-up processing failed", {
      threadId,
      threadChatId,
      error,
    });

    const existingRetries = (threadChat.messages ?? []).filter(
      (m) =>
        m.type === "system" &&
        (m as { message_type: string }).message_type ===
          "follow-up-retry-failed",
    ).length;

    if (existingRetries >= MAX_FOLLOW_UP_RETRIES - 1) {
      await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId,
        eventType: "system.error",
        chatUpdates: {
          replaceQueuedMessages: [],
          errorMessage: "agent-generic-error",
          errorMessageInfo: `Follow-up failed ${existingRetries + 1} times`,
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
      await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId,
        eventType: "system.error",
        chatUpdates: {
          appendMessages: [
            {
              type: "system",
              message_type: "follow-up-retry-failed",
              parts: [
                {
                  type: "text" as const,
                  text: `Follow-up attempt ${existingRetries + 1} failed: ${error instanceof Error ? error.message : "unknown"}`,
                },
              ],
              timestamp: new Date().toISOString(),
            },
          ],
        },
      });
    }
  }
}
