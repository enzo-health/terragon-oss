import { db } from "@/lib/db";
import { DBUserMessage, DBSystemMessage } from "@leo/shared";
import { updateThreadChat } from "@leo/shared/model/threads";
import { getPostHogServer } from "@/lib/posthog-server";
import { convertToPlainText } from "@/lib/db-message-helpers";
import { compactThreadChat } from "@/server-lib/compact";
import { updateThreadChatWithTransition } from "./update-status";
import { withThreadChat } from "./thread-resource";
import { ThreadError } from "./error";

export interface SlashCommandResult {
  handled: boolean;
}

export function getSlashCommandOrNull(message: DBUserMessage): string | null {
  const messageText = convertToPlainText({ message }).trim();
  if (messageText === "/clear") {
    return "/clear";
  }
  if (messageText === "/compact") {
    return "/compact";
  }
  return null;
}

export async function handleSlashCommand({
  userId,
  threadId,
  threadChatId,
  message,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  message: DBUserMessage;
}): Promise<SlashCommandResult> {
  const command = getSlashCommandOrNull(message);
  if (command === "/clear") {
    return await handleClearCommand({
      userId,
      threadId,
      threadChatId,
      message,
    });
  }
  if (command === "/compact") {
    return await handleCompactCommand({
      userId,
      threadId,
      threadChatId,
      message,
    });
  }

  // Let /test-prompt-too-long pass through to the daemon for end-to-end testing
  // The daemon will handle it and send back a mock error response

  // No slash command detected
  return {
    handled: false,
  };
}

async function handleClearCommand({
  userId,
  threadId,
  threadChatId,
  message,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  message: DBUserMessage;
}) {
  console.log("Processing /clear command");
  getPostHogServer().capture({
    distinctId: userId,
    event: "slash_command",
    properties: {
      threadId,
      threadChatId,
      command: "clear",
    },
  });
  const systemMessage: DBSystemMessage = {
    type: "system",
    message_type: "clear-context",
    parts: [],
    timestamp: new Date().toISOString(),
  };
  await updateThreadChatWithTransition({
    userId,
    threadId,
    threadChatId,
    eventType: "system.slash-command-done",
    chatUpdates: {
      appendMessages: [message, systemMessage],
      sessionId: null,
      errorMessage: null,
      errorMessageInfo: null,
      contextLength: null,
    },
  });
  return {
    handled: true,
  };
}

async function handleCompactCommand({
  userId,
  threadId,
  threadChatId,
  message,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  message: DBUserMessage;
}) {
  console.log("Processing /compact command");
  getPostHogServer().capture({
    distinctId: userId,
    event: "slash_command",
    properties: {
      threadId,
      threadChatId,
      command: "compact",
    },
  });
  await updateThreadChat({
    db,
    userId,
    threadId,
    threadChatId,
    updates: {
      appendMessages: [message],
    },
  });
  await withThreadChat({
    threadId,
    threadChatId,
    userId,
    execOrThrow: async () => {
      const compactResult = await compactThreadChat({
        threadId,
        userId,
        threadChatId,
      });
      if (!compactResult) {
        throw new ThreadError(
          "unknown-error",
          "Failed to compact thread",
          null,
        );
      }
      const systemMessage: DBSystemMessage = {
        type: "system",
        message_type: "compact-result",
        parts: [{ type: "text", text: compactResult.summary }],
        timestamp: new Date().toISOString(),
      };
      await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId,
        eventType: "system.slash-command-done",
        chatUpdates: {
          appendMessages: [systemMessage],
          sessionId: null,
          errorMessage: null,
          errorMessageInfo: null,
          contextLength: null,
        },
      });
    },
  });
  return {
    handled: true,
  };
}
