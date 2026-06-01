import { db } from "@/lib/db";
import { DBUserMessage } from "@terragon/shared";
import { waitUntil } from "@vercel/functions";
import { dispatchAgentMessage } from "@/agent/msg/startAgentMessage";
import { convertToPlainText } from "@/lib/db-message-helpers";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import {
  getThreadChat,
  getThreadMinimal,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import {
  isPrimaryChatLiveThreadStatus,
  shouldProcessQueuedFollowUpImmediately,
} from "@terragon/shared/model/thread-lifecycle-policy";
import {
  ensureDispatchRetryPersistenceOwnership,
  maybeProcessFollowUpQueue,
} from "./process-follow-up-queue";
import { persistSideEffectAgUiMessages } from "./ag-ui-side-effect-messages";
import { getDefaultModelForAgent } from "@terragon/agent/utils";
import { uploadUserMessageImages } from "@/lib/r2-file-upload-server";

export type FollowUpSource = "www" | "github" | "linear" | "slack";

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
  source: FollowUpSource;
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
  if (isPrimaryChatLiveThreadStatus(threadChat.status)) {
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
  source: FollowUpSource;
}): Promise<boolean> {
  const latestThreadChat = await getThreadChat({
    db,
    threadId,
    userId,
    threadChatId,
  });
  if (
    !latestThreadChat ||
    !isPrimaryChatLiveThreadStatus(latestThreadChat.status)
  ) {
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
  dedupeMarker,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  messages: DBUserMessage[];
  appendOrReplace: "append" | "replace";
  source: FollowUpSource;
  dedupeMarker?: string;
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
  let messagesToQueue = messages;
  if (dedupeMarker) {
    messagesToQueue = filterMessagesByDedupeMarker({
      incomingMessages: messages,
      existingMessages: threadChat.messages ?? [],
      existingQueuedMessages: threadChat.queuedMessages ?? [],
      dedupeMarker,
    });
  } else if (source === "github") {
    messagesToQueue = filterAlreadyQueuedOrSubmittedMessages({
      incomingMessages: messages,
      existingMessages: threadChat.messages ?? [],
      existingQueuedMessages: threadChat.queuedMessages ?? [],
    });
  }
  if (messagesToQueue.length === 0) {
    return;
  }
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
  if (shouldProcessQueuedFollowUpImmediately(threadChat.status)) {
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

function filterMessagesByDedupeMarker({
  incomingMessages,
  existingMessages,
  existingQueuedMessages,
  dedupeMarker,
}: {
  incomingMessages: DBUserMessage[];
  existingMessages: unknown[];
  existingQueuedMessages: DBUserMessage[];
  dedupeMarker: string;
}): DBUserMessage[] {
  const existingHasMarker =
    existingMessages.some(
      (message) =>
        isUserMessage(message) &&
        normalizedUserMessageText(message).includes(dedupeMarker),
    ) ||
    existingQueuedMessages.some((message) =>
      normalizedUserMessageText(message).includes(dedupeMarker),
    );
  if (existingHasMarker) {
    return [];
  }

  let markerSeenInBatch = false;
  return incomingMessages.filter((message) => {
    if (!normalizedUserMessageText(message).includes(dedupeMarker)) {
      return true;
    }
    if (markerSeenInBatch) {
      return false;
    }
    markerSeenInBatch = true;
    return true;
  });
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
