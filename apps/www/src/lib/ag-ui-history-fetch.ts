import { EventType, type Message as AgUiMessage } from "@ag-ui/core";
import type {
  AgUiHistoryItem,
  AgUiHistoryMessagesResult,
  TerragonCustomPartEvent,
} from "./ag-ui-history-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgUiHistoryMessage(value: unknown): value is AgUiMessage {
  if (!isRecord(value)) {
    return false;
  }
  const id = value.id;
  const role = value.role;
  const content = value.content;
  if (typeof id !== "string") {
    return false;
  }
  if (role === "user") {
    return typeof content === "string" || Array.isArray(content);
  }
  if (role === "system") {
    return typeof content === "string";
  }
  if (role === "assistant") {
    return content === undefined || typeof content === "string";
  }
  if (role === "tool") {
    return typeof value.toolCallId === "string" && typeof content === "string";
  }
  return false;
}

function isTerragonCustomPartEvent(
  value: unknown,
): value is TerragonCustomPartEvent {
  return (
    isRecord(value) &&
    value.type === EventType.CUSTOM &&
    typeof value.name === "string" &&
    value.name === "terragon.data-part"
  );
}

function isAgUiHistoryItem(value: unknown): value is AgUiHistoryItem {
  return isAgUiHistoryMessage(value) || isTerragonCustomPartEvent(value);
}

export function parseAgUiHistoryMessagesResponse(
  value: unknown,
): AgUiHistoryMessagesResult {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error("Invalid AG UI history response");
  }
  if (!value.messages.every(isAgUiHistoryItem)) {
    throw new Error("Invalid AG UI history item");
  }
  const lastSeq = value.lastSeq;
  if (
    typeof lastSeq !== "number" ||
    !Number.isSafeInteger(lastSeq) ||
    lastSeq < -1
  ) {
    throw new Error("Invalid AG UI history cursor");
  }
  return { messages: value.messages, lastSeq };
}

/**
 * Fetch the AG-UI history messages snapshot for a (threadId, threadChatId).
 * Shared by ChatUI's runtime hydration and the sidebar prefetch path.
 */
export async function fetchAgUiHistoryMessages({
  threadId,
  threadChatId,
  signal,
}: {
  threadId: string;
  threadChatId: string;
  signal?: AbortSignal;
}): Promise<AgUiHistoryMessagesResult> {
  const query = new URLSearchParams({
    threadChatId,
    history: "messages",
  });
  const response = await fetch(
    `/api/ag-ui/${encodeURIComponent(threadId)}?${query.toString()}`,
    { cache: "no-store", signal },
  );
  if (!response.ok) {
    throw new Error(`Failed to load AG UI history (${response.status})`);
  }
  return parseAgUiHistoryMessagesResponse(await response.json());
}
