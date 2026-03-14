import { db } from "@/lib/db";
import {
  getThreadChat,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import { MAX_CONTEXT_TOKENS, DBMessage } from "@terragon/shared";
import { getPostHogServer } from "@/lib/posthog-server";
import { generateSessionSummary } from "./generate-session-summary";
import { formatThreadToMsg } from "@/lib/thread-to-msg-formatter";

/**
 * Gets the messages to process for compaction by finding the last
 * compact-result or clear-context marker and returning messages after it.
 * This ensures /compact respects /clear commands.
 */
export function getMessagesToProcess(messages: DBMessage[]): DBMessage[] {
  // Find the last compact-result or clear-context message to only process messages after it
  let lastCompactIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message &&
      message.type === "system" &&
      (message.message_type === "compact-result" ||
        message.message_type === "clear-context")
    ) {
      lastCompactIndex = i;
      break;
    }
  }

  // Only get history after the last compact-result or clear-context
  let messagesToProcess =
    lastCompactIndex >= 0 ? messages.slice(lastCompactIndex + 1) : messages;

  // Filter out tool result messages (those with parent_tool_use_id)
  messagesToProcess = messagesToProcess.filter((msg) => {
    return !("parent_tool_use_id" in msg) || msg.parent_tool_use_id == null;
  });

  return messagesToProcess;
}

export async function getThreadChatHistory({
  userId,
  threadId,
  threadChatId,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
}): Promise<string> {
  const threadChat = await getThreadChat({
    db,
    userId,
    threadId,
    threadChatId,
  });
  if (!threadChat) {
    return "";
  }
  const messages = threadChat.messages ?? [];
  const messagesToProcess = getMessagesToProcess(messages);
  return formatThreadToMsg(messagesToProcess);
}

export async function compactThreadChat({
  userId,
  threadId,
  threadChatId,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
}): Promise<{ summary: string } | null> {
  try {
    const history = await getThreadChatHistory({
      userId,
      threadId,
      threadChatId,
    });
    const summary = await generateSessionSummary({ sessionHistory: history });
    return { summary: summary ?? "Failed to generate summary" };
  } catch (e) {
    console.error(e);
    return {
      summary: "Failed to generate summary",
    };
  }
}

export async function tryAutoCompactThread({
  userId,
  threadId,
  threadChatId,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
}): Promise<{
  didCompact: boolean;
  summary: string | null;
}> {
  // Auto-compact is now enabled for all users
  const threadChat = await getThreadChat({
    db,
    threadId,
    userId,
    threadChatId,
  });
  if (!threadChat) {
    return { didCompact: false, summary: null };
  }
  // Check if we need to auto-compact based on context length or message count.
  // Message count fallback handles agents (e.g. Codex) that don't report token usage,
  // leaving contextLength NULL even when the context window is exhausted.
  const MAX_MESSAGE_COUNT_FALLBACK = 800;
  const messageCount = threadChat.messages?.length ?? 0;
  const shouldCompact =
    (threadChat.contextLength != null &&
      threadChat.contextLength > MAX_CONTEXT_TOKENS) ||
    (threadChat.contextLength == null &&
      messageCount > MAX_MESSAGE_COUNT_FALLBACK);
  if (shouldCompact) {
    const compactReason =
      threadChat.contextLength != null
        ? "context_length"
        : "message_count_fallback";
    console.log("Auto-compacting", {
      threadId,
      threadChatId: threadChat.id,
      reason: compactReason,
      contextLength: threadChat.contextLength,
      messageCount,
      maxContextTokens: MAX_CONTEXT_TOKENS,
    });
    getPostHogServer().capture({
      distinctId: userId,
      event: "auto_compact",
      properties: {
        threadId,
        reason: compactReason,
        contextLength: threadChat.contextLength,
        messageCount,
        maxContextTokens: MAX_CONTEXT_TOKENS,
      },
    });
    const compactResult = await compactThreadChat({
      userId,
      threadId,
      threadChatId,
    });
    if (compactResult) {
      const systemMessage = {
        type: "system" as const,
        message_type: "compact-result" as const,
        parts: [
          {
            type: "text" as const,
            text: compactResult.summary,
          },
        ],
        timestamp: new Date().toISOString(),
      };
      await updateThreadChat({
        db,
        userId,
        threadId,
        threadChatId,
        updates: {
          appendMessages: [systemMessage],
          contextLength: null,
          sessionId: null,
        },
      });
      console.log("Auto-compacted", {
        threadId,
        threadChatId: threadChat.id,
      });
      return {
        didCompact: true,
        summary: compactResult.summary,
      };
    }
  }

  return { didCompact: false, summary: null };
}
