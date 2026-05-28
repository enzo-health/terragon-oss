import type { Message } from "@ag-ui/core";
import type { DBMessage } from "@terragon/shared";
import {
  type DurableAgUiHistoryItem,
  dbMessagesToNativeAgUiSnapshotMessages,
} from "@/server-lib/ag-ui-side-effect-messages";

type AgUiUserMessage = Extract<Message, { role: "user" }>;
type AgUiAssistantMessage = Extract<Message, { role: "assistant" }>;
type AgUiTextBackfillMessage = AgUiUserMessage | AgUiAssistantMessage;

function isAgUiTextBackfillMessage(
  item: DurableAgUiHistoryItem,
): item is AgUiTextBackfillMessage {
  const role = Reflect.get(item, "role");
  return role === "user" || role === "assistant";
}

function agUiMessageContentText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (part === null || typeof part !== "object") {
        return "";
      }
      const type = Reflect.get(part, "type");
      const text = Reflect.get(part, "text");
      return type === "text" && typeof text === "string" ? text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}

function agUiTextMessageSignature(message: AgUiTextBackfillMessage): string {
  const content = agUiMessageContentText(message.content);
  return `${message.role}:${content}`;
}

function extractAgentMessageText(
  message: Extract<DBMessage, { type: "agent" }>,
): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}

function dbMessagesToTextBackfillMessages(
  dbMessages: readonly DBMessage[],
): AgUiTextBackfillMessage[] {
  const messages: AgUiTextBackfillMessage[] = [];

  dbMessages.forEach((dbMessage, index) => {
    if (dbMessage.type === "user") {
      const [message] = dbMessagesToNativeAgUiSnapshotMessages([dbMessage]);
      if (message && isAgUiTextBackfillMessage(message)) {
        messages.push(message);
      }
      return;
    }

    if (dbMessage.type !== "agent") {
      return;
    }
    const content = extractAgentMessageText(dbMessage);
    if (content.length === 0) {
      return;
    }
    messages.push({
      id: `db-agent-backfill-${index}`,
      role: "assistant",
      content,
    });
  });

  return messages;
}

export function mergeMissingDbUserMessagesIntoHistory({
  historyItems,
  dbMessages,
}: {
  historyItems: DurableAgUiHistoryItem[];
  dbMessages: readonly DBMessage[];
}): DurableAgUiHistoryItem[] {
  const historyIndicesBySignature = new Map<string, number[]>();
  historyItems.forEach((item, index) => {
    if (!isAgUiTextBackfillMessage(item)) {
      return;
    }
    const signature = agUiTextMessageSignature(item);
    const indices = historyIndicesBySignature.get(signature) ?? [];
    indices.push(index);
    historyIndicesBySignature.set(signature, indices);
  });

  const missingBeforeIndex = new Map<number, AgUiTextBackfillMessage[]>();
  const appendedMessages: AgUiTextBackfillMessage[] = [];
  const pendingMissingMessages: AgUiTextBackfillMessage[] = [];
  let lastMatchedHistoryIndex: number | null = null;

  for (const message of dbMessagesToTextBackfillMessages(dbMessages)) {
    const content = agUiMessageContentText(message.content);
    if (content.length === 0) {
      continue;
    }
    const matchingHistoryIndices = historyIndicesBySignature.get(
      agUiTextMessageSignature(message),
    );
    const matchingHistoryIndex = matchingHistoryIndices?.shift();
    if (matchingHistoryIndex === undefined) {
      pendingMissingMessages.push(message);
      continue;
    }
    if (pendingMissingMessages.length > 0) {
      missingBeforeIndex.set(matchingHistoryIndex, [
        ...(missingBeforeIndex.get(matchingHistoryIndex) ?? []),
        ...pendingMissingMessages.splice(0),
      ]);
    }
    lastMatchedHistoryIndex = matchingHistoryIndex;
  }

  if (pendingMissingMessages.length > 0 && lastMatchedHistoryIndex !== null) {
    appendedMessages.push(...pendingMissingMessages.splice(0));
  }

  const prependedMessages = [...pendingMissingMessages];
  if (
    prependedMessages.length === 0 &&
    missingBeforeIndex.size === 0 &&
    appendedMessages.length === 0
  ) {
    return historyItems;
  }

  const merged: DurableAgUiHistoryItem[] = [...prependedMessages];
  historyItems.forEach((item, index) => {
    merged.push(...(missingBeforeIndex.get(index) ?? []), item);
  });
  merged.push(...appendedMessages);
  return merged;
}
