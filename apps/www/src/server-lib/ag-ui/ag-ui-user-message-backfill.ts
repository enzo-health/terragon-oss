import type { Message } from "@ag-ui/core";
import type { DBMessage } from "@terragon/shared";
import {
  type DurableAgUiHistoryItem,
  dbMessagesToNativeAgUiSnapshotMessages,
} from "@/server-lib/ag-ui-side-effect-messages";

type AgUiUserMessage = Extract<Message, { role: "user" }>;

function isAgUiUserMessage(
  item: DurableAgUiHistoryItem,
): item is AgUiUserMessage {
  return Reflect.get(item, "role") === "user";
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

function agUiUserMessageSignature(message: AgUiUserMessage): string {
  const content = agUiMessageContentText(message.content);
  return `user:${content}`;
}

export function mergeMissingDbUserMessagesIntoHistory({
  historyItems,
  dbMessages,
}: {
  historyItems: DurableAgUiHistoryItem[];
  dbMessages: readonly DBMessage[];
}): DurableAgUiHistoryItem[] {
  const historyUserIndicesBySignature = new Map<string, number[]>();
  historyItems.forEach((item, index) => {
    if (!isAgUiUserMessage(item)) {
      return;
    }
    const signature = agUiUserMessageSignature(item);
    const indices = historyUserIndicesBySignature.get(signature) ?? [];
    indices.push(index);
    historyUserIndicesBySignature.set(signature, indices);
  });

  const missingBeforeIndex = new Map<number, AgUiUserMessage[]>();
  const appendedMessages: AgUiUserMessage[] = [];
  const pendingMissingUserMessages: AgUiUserMessage[] = [];
  let lastMatchedHistoryIndex: number | null = null;

  for (const message of dbMessagesToNativeAgUiSnapshotMessages(dbMessages)) {
    if (!isAgUiUserMessage(message)) {
      continue;
    }
    const content = agUiMessageContentText(message.content);
    if (content.length === 0) {
      continue;
    }
    const matchingHistoryIndices = historyUserIndicesBySignature.get(
      agUiUserMessageSignature(message),
    );
    const matchingHistoryIndex = matchingHistoryIndices?.shift();
    if (matchingHistoryIndex === undefined) {
      pendingMissingUserMessages.push(message);
      continue;
    }
    if (pendingMissingUserMessages.length > 0) {
      missingBeforeIndex.set(matchingHistoryIndex, [
        ...(missingBeforeIndex.get(matchingHistoryIndex) ?? []),
        ...pendingMissingUserMessages.splice(0),
      ]);
    }
    lastMatchedHistoryIndex = matchingHistoryIndex;
  }

  if (
    pendingMissingUserMessages.length > 0 &&
    lastMatchedHistoryIndex !== null
  ) {
    appendedMessages.push(...pendingMissingUserMessages.splice(0));
  }

  const prependedMessages = [...pendingMissingUserMessages];
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
