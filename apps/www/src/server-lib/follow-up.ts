import { db } from "@/lib/db";
import { DBUserMessage } from "@terragon/shared";
import { waitUntil } from "@vercel/functions";
import { dispatchAgentMessage } from "@/agent/msg/startAgentMessage";
import { getPostHogServer } from "@/lib/posthog-server";
import {
  convertToPlainText,
  estimateMessageSize,
  imageCount,
} from "@/lib/db-message-helpers";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import {
  getThreadChat,
  getThreadMinimal,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import {
  ensureDispatchRetryPersistenceOwnership,
  maybeProcessFollowUpQueue,
} from "./process-follow-up-queue";
import { persistSideEffectAgUiMessages } from "./ag-ui-side-effect-messages";
import { isAgentWorking } from "@/agent/thread-status";
import { getDefaultModelForAgent, modelToAgent } from "@terragon/agent/utils";
import { uploadUserMessageImages } from "@/lib/r2-file-upload-server";

export async function followUpInternal({
  userId,
  threadId,
  threadChatId,
  message,
  source,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  message: DBUserMessage;
  source: "www" | "github";
}) {
  const threadChat = await getThreadChat({
    db,
    threadId,
    userId,
    threadChatId,
  });
  if (!threadChat) {
    throw new Error("Thread chat not found");
  }
  if (isAgentWorking(threadChat.status)) {
    await queueFollowUpInternal({
      userId,
      threadId,
      threadChatId: threadChat.id,
      messages: [message],
      appendOrReplace: "append",
      source,
    });
    return;
  }
  getPostHogServer().capture({
    distinctId: userId,
    event: "follow_up",
    properties: {
      threadId,
      model: message.model,
      agentType: modelToAgent(message.model),
      imageCount: imageCount(message),
      promptTextSize: estimateMessageSize(message),
      source,
    },
  });
  const { didUpdateStatus, updatedStatus } =
    await updateThreadChatWithTransition({
      userId,
      threadId,
      threadChatId: threadChat.id,
      eventType: "user.message",
      chatUpdates: {
        errorMessage: null,
        errorMessageInfo: null,
        permissionMode: message.permissionMode || "allowAll",
      },
    });
  if (!didUpdateStatus) {
    const didQueueForActiveRun = await queueFollowUpIfThreadIsActive({
      userId,
      threadId,
      threadChatId: threadChat.id,
      message,
      source,
    });
    if (didQueueForActiveRun) {
      return;
    }
    throw new Error("Failed to update thread");
  }
  if (updatedStatus === "scheduled") {
    const uploadedMessage = await uploadUserMessageImages({ userId, message });
    const { chatSequence } = await updateThreadChat({
      db,
      userId,
      threadId,
      threadChatId: threadChat.id,
      updates: {
        appendMessages: [uploadedMessage],
      },
    });
    await persistSideEffectAgUiMessages({
      db,
      threadId,
      threadChatId: threadChat.id,
      messages: [uploadedMessage],
      source: "scheduled-follow-up-user-prompt",
      chatSequence,
      runId: `pre-run:${threadChat.id}:scheduled-follow-up-user-prompt:${chatSequence ?? "unknown"}`,
    });
    return;
  }
  const messageWithModel = {
    ...message,
    model:
      message.model ||
      getDefaultModelForAgent({
        agent: threadChat.agent,
        agentVersion: threadChat.agentVersion,
      }),
  };
  const thread = await getThreadMinimal({ db, threadId, userId });
  waitUntil(
    dispatchAgentMessage({
      db,
      message: messageWithModel,
      userId,
      threadId,
      threadChatId: threadChat.id,
      // It is possible that the thread was queued, stopped while it was queued and now the user sends a follow up
      // which means we have a follow up to a thread without a codesandboxId. In this case, we need to pass
      // isNewThread: true.
      isNewThread: !thread?.codesandboxId,
    }),
  );
}

async function queueFollowUpIfThreadIsActive({
  userId,
  threadId,
  threadChatId,
  message,
  source,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  message: DBUserMessage;
  source: "www" | "github";
}): Promise<boolean> {
  const latestThreadChat = await getThreadChat({
    db,
    threadId,
    userId,
    threadChatId,
  });
  if (!latestThreadChat || !isAgentWorking(latestThreadChat.status)) {
    return false;
  }
  await queueFollowUpInternal({
    userId,
    threadId,
    threadChatId: latestThreadChat.id,
    messages: [message],
    appendOrReplace: "append",
    source,
  });
  return true;
}

export async function queueFollowUpInternal({
  userId,
  threadId,
  threadChatId,
  messages,
  appendOrReplace,
  source,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  messages: DBUserMessage[];
  appendOrReplace: "append" | "replace";
  source: "www" | "github";
}) {
  const threadChat = await getThreadChat({
    db,
    threadId,
    userId,
    threadChatId,
  });
  if (!threadChat) {
    throw new Error("Thread chat not found");
  }
  const messagesToQueue =
    source === "github"
      ? filterAlreadyQueuedOrSubmittedMessages({
          incomingMessages: messages,
          existingMessages: threadChat.messages ?? [],
          existingQueuedMessages: threadChat.queuedMessages ?? [],
        })
      : messages;
  if (messagesToQueue.length === 0) {
    return;
  }
  getPostHogServer().capture({
    distinctId: userId,
    event: "queue_follow_up",
    properties: {
      threadId,
      source,
      model: messagesToQueue[0]?.model ?? null,
      agentType: modelToAgent(messagesToQueue[0]?.model ?? null),
      imageCount: messagesToQueue.reduce(
        (acc, message) => acc + imageCount(message),
        0,
      ),
      promptTextSize: messagesToQueue.reduce(
        (acc, message) => acc + estimateMessageSize(message),
        0,
      ),
    },
  });
  await updateThreadChat({
    db,
    userId,
    threadId,
    threadChatId,
    updates: {
      appendQueuedMessages:
        appendOrReplace === "append" ? messagesToQueue : undefined,
      replaceQueuedMessages:
        appendOrReplace === "replace" ? messagesToQueue : undefined,
    },
  });
  const shouldProcessImmediately =
    (threadChat.status !== "scheduled" && !isAgentWorking(threadChat.status)) ||
    threadChat.status === "working-done" ||
    threadChat.status === "working-error";
  if (shouldProcessImmediately) {
    waitUntil(
      maybeProcessFollowUpQueue({ userId, threadId, threadChatId }).then(
        (result) =>
          ensureDispatchRetryPersistenceOwnership({
            owner: "follow-up",
            userId,
            threadId,
            threadChatId,
            result,
          }),
      ),
    );
  }
}

function filterAlreadyQueuedOrSubmittedMessages({
  incomingMessages,
  existingMessages,
  existingQueuedMessages,
}: {
  incomingMessages: DBUserMessage[];
  existingMessages: unknown[];
  existingQueuedMessages: DBUserMessage[];
}): DBUserMessage[] {
  const existingText = new Set<string>();
  for (const message of existingMessages) {
    if (isUserMessage(message)) {
      existingText.add(normalizedUserMessageText(message));
    }
  }
  for (const message of existingQueuedMessages) {
    existingText.add(normalizedUserMessageText(message));
  }

  return incomingMessages.filter((message) => {
    const text = normalizedUserMessageText(message);
    if (existingText.has(text)) {
      return false;
    }
    existingText.add(text);
    return true;
  });
}

function isUserMessage(message: unknown): message is DBUserMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "user"
  );
}

function normalizedUserMessageText(message: DBUserMessage): string {
  return convertToPlainText({ message }).trim();
}
