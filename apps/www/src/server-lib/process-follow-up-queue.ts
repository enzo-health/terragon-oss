import { db } from "@/lib/db";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { getSlashCommandOrNull } from "@/agent/slash-command-handler";
import { startAgentMessage } from "@/agent/msg/startAgentMessage";
import { getLastUserMessageModel } from "@/lib/db-message-helpers";
import { getDefaultModelForAgent } from "@terragon/agent/utils";
import { getThreadChat } from "@terragon/shared/model/threads";

export async function maybeProcessFollowUpQueue({
  userId,
  threadId,
  threadChatId,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
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
    const startRequestId = crypto.randomUUID();
    await startAgentMessage({
      db,
      userId,
      message: messageWithModel,
      threadId,
      threadChatId,
      isNewThread: false,
      startRequestId,
      triggerSource: "slash_command",
    });
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
  const startRequestId = crypto.randomUUID();
  await startAgentMessage({
    db,
    userId,
    threadId,
    threadChatId,
    isNewThread: false,
    startRequestId,
    triggerSource: "follow_up_queue",
  });
}
