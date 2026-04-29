import { createHash } from "node:crypto";
import {
  type CustomEvent,
  EventType,
  type BaseEvent,
  type Message,
  type MessagesSnapshotEvent,
  type RawEvent,
  type TextMessageChunkEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
} from "@ag-ui/core";
import type {
  DBMessage,
  DBRichTextPart,
  DBSystemMessage,
  DBUserMessage,
} from "@terragon/shared";
import type { DB } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import {
  getAgUiEventEnvelopesForThreadChat,
  getLatestRunIdForThreadChat,
} from "@terragon/shared/model/agent-event-log";
import { and, eq, sql } from "drizzle-orm";
import { persistAndPublishAgUiEvents } from "./ag-ui-publisher";

const INVALID_TOKEN_RETRY_MARKER_NAME =
  "terragon.side-effect.invalid-token-retry";

export type PersistSideEffectAgUiMessagesParams = {
  db: DB;
  threadId: string;
  threadChatId: string;
  messages: readonly DBMessage[];
  source: string;
  chatSequence?: number;
  runId?: string | null;
};

export type NativeAgUiTranscript = {
  history: string;
  messageCount: number;
};

export type DurableAgUiHistoryItem = Message | CustomEvent;

type NativeAgUiSnapshotSystemMessageType =
  | DBSystemMessage["message_type"]
  | "error"
  | "tool-result"
  | "unknown";

export type NativeAgUiSnapshotMessage =
  | { role: "user"; content: string }
  | {
      role: "system";
      messageType: NativeAgUiSnapshotSystemMessageType;
      content: string;
    };

type NativeAgUiSideEffectSystemMessageType =
  | "cancel-schedule"
  | "compact-result"
  | "invalid-token-retry"
  | "retry-git-commit-and-push"
  | "generic-retry"
  | "clear-context"
  | "agent-error-retry"
  | "follow-up-retry-failed";

const NATIVE_AG_UI_SIDE_EFFECT_SYSTEM_MESSAGE_TYPES =
  new Set<NativeAgUiSideEffectSystemMessageType>([
    "cancel-schedule",
    "compact-result",
    "invalid-token-retry",
    "retry-git-commit-and-push",
    "generic-retry",
    "clear-context",
    "agent-error-retry",
    "follow-up-retry-failed",
  ]);

export async function persistSideEffectAgUiMessages({
  db,
  threadId,
  threadChatId,
  messages,
  source,
  chatSequence,
  runId,
}: PersistSideEffectAgUiMessagesParams): Promise<void> {
  const agUiMessages = dbMessagesToNativeAgUiSnapshotMessages(messages);
  if (agUiMessages.length === 0) {
    return;
  }
  const resolvedRunId = await resolveSideEffectRunId({
    db,
    threadChatId,
    explicitRunId: runId,
    source,
  });
  if (!resolvedRunId) {
    return;
  }

  const timestamp = new Date();
  const event: MessagesSnapshotEvent = {
    type: EventType.MESSAGES_SNAPSHOT,
    timestamp: timestamp.getTime(),
    messages: agUiMessages,
  };
  const contentHash = stableHash({ source, messages: agUiMessages });
  const sequenceKey =
    chatSequence === undefined
      ? contentHash.slice(0, 16)
      : String(chatSequence);

  await persistAndPublishAgUiEvents({
    db,
    threadId,
    threadChatId,
    runId: resolvedRunId,
    rows: [
      {
        event: event as BaseEvent,
        eventId: `side-effect:${source}:${sequenceKey}:${contentHash.slice(0, 12)}`,
        timestamp,
        threadChatMessageSeq: chatSequence,
      },
    ],
  });
}

export async function persistInvalidTokenRetrySideEffectMarker({
  db,
  threadId,
  threadChatId,
  runId,
  chatSequence,
}: {
  db: DB;
  threadId: string;
  threadChatId: string;
  runId?: string | null;
  chatSequence?: number;
}): Promise<void> {
  const resolvedRunId = await resolveSideEffectRunId({
    db,
    threadChatId,
    explicitRunId: runId,
    source: "invalid-token-retry-marker",
  });
  if (!resolvedRunId) {
    return;
  }
  const timestamp = new Date();
  const value = {
    reason: "oauth-token-revoked",
    threadId,
    threadChatId,
  };
  const event: RawEvent = {
    type: EventType.RAW,
    timestamp: timestamp.getTime(),
    source: INVALID_TOKEN_RETRY_MARKER_NAME,
    event: value,
  };
  const contentHash = stableHash({
    source: INVALID_TOKEN_RETRY_MARKER_NAME,
    value,
  });
  const sequenceKey =
    chatSequence === undefined
      ? contentHash.slice(0, 16)
      : String(chatSequence);

  await persistAndPublishAgUiEvents({
    db,
    threadId,
    threadChatId,
    runId: resolvedRunId,
    rows: [
      {
        event,
        eventId: `side-effect:invalid-token-retry:${sequenceKey}:${contentHash.slice(0, 12)}`,
        timestamp,
        threadChatMessageSeq: chatSequence,
      },
    ],
  });
}

export async function hasInvalidTokenRetrySideEffectMarker({
  db,
  threadChatId,
}: {
  db: DB;
  threadChatId: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ eventId: schema.agentEventLog.eventId })
    .from(schema.agentEventLog)
    .where(
      and(
        eq(schema.agentEventLog.threadChatId, threadChatId),
        eq(schema.agentEventLog.eventType, EventType.RAW),
        sql`${schema.agentEventLog.payloadJson}->>'source' = ${INVALID_TOKEN_RETRY_MARKER_NAME}`,
      ),
    )
    .limit(1);

  return row !== undefined;
}

async function resolveSideEffectRunId({
  db,
  threadChatId,
  explicitRunId,
  source,
}: {
  db: DB;
  threadChatId: string;
  explicitRunId?: string | null;
  source: string;
}): Promise<string | null> {
  if (explicitRunId && explicitRunId.length > 0) {
    return explicitRunId;
  }

  const latestRunId = await getLatestRunIdForThreadChat({
    db,
    threadChatId,
  });
  if (latestRunId) {
    return latestRunId;
  }

  console.warn(
    "[ag-ui-side-effect-messages] skipping side-effect persistence without native run",
    {
      threadChatId,
      source,
    },
  );
  return null;
}

export function dbMessagesToNativeAgUiSnapshotMessages(
  messages: readonly DBMessage[],
): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (message.type === "user") {
      out.push(userMessageToAgUiMessage(message, out.length));
    } else if (message.type === "system") {
      const systemMessage = systemMessageToAgUiMessage(message, out.length);
      if (systemMessage) {
        out.push(systemMessage);
      }
    } else if (message.type === "error") {
      out.push(errorMessageToAgUiMessage(message, out.length));
    } else if (message.type === "tool-result") {
      out.push(toolResultMessageToAgUiMessage(message, out.length));
    }
  }
  return out;
}

export async function getNativeAgUiTranscriptForThreadChat({
  db,
  threadChatId,
}: {
  db: Pick<DB, "query">;
  threadChatId: string;
}): Promise<NativeAgUiTranscript> {
  const envelopes = await getAgUiEventEnvelopesForThreadChat({
    db,
    threadChatId,
  });
  const lines: string[] = [];
  const streamingMessages = new Map<
    string,
    { role: string; contentParts: string[] }
  >();
  let messageCount = 0;

  for (const envelope of envelopes) {
    const event = envelope.payload;
    if (event.type === EventType.MESSAGES_SNAPSHOT) {
      for (const message of (event as MessagesSnapshotEvent).messages) {
        if (isContextResetMessage(message)) {
          lines.length = 0;
          streamingMessages.clear();
          messageCount = 0;
          continue;
        }
        const content = messageContentToText(message.content);
        if (content.length === 0) {
          continue;
        }
        lines.push(`${message.role}: ${content}`);
        messageCount += 1;
      }
      continue;
    }

    if (event.type === EventType.TEXT_MESSAGE_START) {
      const startEvent = event as TextMessageStartEvent;
      streamingMessages.set(startEvent.messageId, {
        role: startEvent.role ?? "assistant",
        contentParts: [],
      });
      continue;
    }

    if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
      const contentEvent = event as TextMessageContentEvent;
      const streamingMessage = streamingMessages.get(contentEvent.messageId);
      if (streamingMessage) {
        streamingMessage.contentParts.push(contentEvent.delta);
      } else if (contentEvent.delta.trim().length > 0) {
        lines.push(`assistant: ${contentEvent.delta}`);
        messageCount += 1;
      }
    }
  }

  for (const streamingMessage of streamingMessages.values()) {
    const content = streamingMessage.contentParts.join("").trim();
    if (content.length === 0) {
      continue;
    }
    lines.push(`${streamingMessage.role}: ${content}`);
    messageCount += 1;
  }

  return {
    history: lines.join("\n\n"),
    messageCount,
  };
}

export function getNativeAgUiHistoryMessagesFromEvents(
  events: readonly BaseEvent[],
): Message[] {
  const messages: Message[] = [];

  for (const event of events) {
    if (event.type !== EventType.MESSAGES_SNAPSHOT) {
      continue;
    }

    for (const message of (event as MessagesSnapshotEvent).messages) {
      if (isContextResetMessage(message)) {
        messages.length = 0;
      }
      if (message.role === "user" || message.role === "system") {
        messages.push(message);
      }
    }
  }

  return messages;
}

export function getDurableAgUiHistoryItemsFromEvents(
  events: readonly BaseEvent[],
): { items: DurableAgUiHistoryItem[]; lastSeqOffset: number } {
  const state = createHistoryBuilderState();

  events.forEach((event, index) => {
    if (applyHistoryEvent(state, event)) {
      state.lastSeqOffset = index;
    }
  });

  return {
    items: state.items,
    lastSeqOffset: state.lastSeqOffset,
  };
}

type HistoryBuilderState = {
  items: DurableAgUiHistoryItem[];
  assistantById: Map<string, Extract<Message, { role: "assistant" }>>;
  toolCallById: Map<
    string,
    NonNullable<Extract<Message, { role: "assistant" }>["toolCalls"]>[number]
  >;
  toolParentById: Map<string, string>;
  lastAssistantId: string | null;
  lastSeqOffset: number;
};

function createHistoryBuilderState(): HistoryBuilderState {
  return {
    items: [],
    assistantById: new Map(),
    toolCallById: new Map(),
    toolParentById: new Map(),
    lastAssistantId: null,
    lastSeqOffset: -1,
  };
}

function applyHistoryEvent(
  state: HistoryBuilderState,
  event: BaseEvent,
): boolean {
  switch (event.type) {
    case EventType.MESSAGES_SNAPSHOT:
      return applyMessagesSnapshot(state, event as MessagesSnapshotEvent);
    case EventType.TEXT_MESSAGE_START:
      return startTextHistoryMessage(state, event as TextMessageStartEvent);
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_CHUNK:
      return appendTextHistoryMessage(
        state,
        event as TextMessageContentEvent | TextMessageChunkEvent,
      );
    case EventType.TEXT_MESSAGE_END:
      return finishTextHistoryMessage(state, event as TextMessageEndEvent);
    case EventType.TOOL_CALL_START:
      return startHistoryToolCall(state, event as ToolCallStartEvent);
    case EventType.TOOL_CALL_ARGS:
    case EventType.TOOL_CALL_CHUNK:
      return appendHistoryToolArgs(state, event as ToolCallArgsEvent);
    case EventType.TOOL_CALL_END:
      return finishHistoryToolCall(state, event as ToolCallEndEvent);
    case EventType.TOOL_CALL_RESULT:
      return addHistoryToolResult(state, event as ToolCallResultEvent);
    case EventType.CUSTOM:
      if (isTerragonCustomPartEvent(event)) {
        state.items.push(event);
        return true;
      }
      return false;
    default:
      return false;
  }
}

function applyMessagesSnapshot(
  state: HistoryBuilderState,
  event: MessagesSnapshotEvent,
): boolean {
  let changed = false;
  for (const message of event.messages) {
    if (isContextResetMessage(message)) {
      changed =
        changed ||
        state.items.length > 0 ||
        state.assistantById.size > 0 ||
        state.toolCallById.size > 0 ||
        state.toolParentById.size > 0 ||
        state.lastAssistantId !== null;
      state.items.length = 0;
      state.assistantById.clear();
      state.toolCallById.clear();
      state.toolParentById.clear();
      state.lastAssistantId = null;
      continue;
    }
    state.items.push(message);
    indexHistoryMessage(state, message);
    changed = true;
  }
  return changed;
}

function indexHistoryMessage(
  state: HistoryBuilderState,
  message: Message,
): void {
  if (message.role !== "assistant") {
    return;
  }
  state.assistantById.set(message.id, message);
  state.lastAssistantId = message.id;
  for (const toolCall of message.toolCalls ?? []) {
    state.toolCallById.set(toolCall.id, toolCall);
    state.toolParentById.set(toolCall.id, message.id);
  }
}

function ensureAssistantHistoryMessage(
  state: HistoryBuilderState,
  messageId: string,
): Extract<Message, { role: "assistant" }> {
  const existing = state.assistantById.get(messageId);
  if (existing) {
    return existing;
  }

  const message: Extract<Message, { role: "assistant" }> = {
    id: messageId,
    role: "assistant",
    content: "",
  };
  state.items.push(message);
  state.assistantById.set(messageId, message);
  state.lastAssistantId = messageId;
  return message;
}

function startTextHistoryMessage(
  state: HistoryBuilderState,
  event: TextMessageStartEvent,
): boolean {
  if (event.role !== "assistant") {
    return false;
  }
  if (state.assistantById.has(event.messageId)) {
    return false;
  }
  ensureAssistantHistoryMessage(state, event.messageId);
  return true;
}

function appendTextHistoryMessage(
  state: HistoryBuilderState,
  event: TextMessageContentEvent | TextMessageChunkEvent,
): boolean {
  if (!event.delta) {
    return false;
  }
  if (!event.messageId) {
    return false;
  }
  const message = ensureAssistantHistoryMessage(state, event.messageId);
  message.content = `${message.content ?? ""}${event.delta}`;
  return true;
}

function finishTextHistoryMessage(
  _state: HistoryBuilderState,
  _event: TextMessageEndEvent,
): boolean {
  return false;
}

function startHistoryToolCall(
  state: HistoryBuilderState,
  event: ToolCallStartEvent,
): boolean {
  const resolvedParentMessageId = event.parentMessageId
    ? state.assistantById.has(event.parentMessageId)
      ? event.parentMessageId
      : state.toolParentById.get(event.parentMessageId)
    : undefined;
  const parentMessageId =
    resolvedParentMessageId ??
    state.lastAssistantId ??
    `${event.toolCallId}:assistant`;
  const parent = ensureAssistantHistoryMessage(state, parentMessageId);
  const toolCalls = parent.toolCalls ?? [];
  const existing = toolCalls.find(
    (toolCall) => toolCall.id === event.toolCallId,
  );
  if (existing) {
    return false;
  }
  const toolCall = {
    id: event.toolCallId,
    type: "function" as const,
    function: {
      name: event.toolCallName,
      arguments: "",
    },
  };
  parent.toolCalls = [...toolCalls, toolCall];
  state.toolCallById.set(event.toolCallId, toolCall);
  state.toolParentById.set(event.toolCallId, parentMessageId);
  return true;
}

function appendHistoryToolArgs(
  state: HistoryBuilderState,
  event: ToolCallArgsEvent,
): boolean {
  if (!event.delta) {
    return false;
  }
  const toolCall = state.toolCallById.get(event.toolCallId);
  if (!toolCall) {
    return false;
  }
  toolCall.function.arguments = `${toolCall.function.arguments}${event.delta}`;
  return true;
}

function finishHistoryToolCall(
  _state: HistoryBuilderState,
  _event: ToolCallEndEvent,
): boolean {
  return false;
}

function addHistoryToolResult(
  state: HistoryBuilderState,
  event: ToolCallResultEvent,
): boolean {
  const content =
    typeof event.content === "string"
      ? event.content
      : JSON.stringify(event.content);
  const failed = isFailedToolResultEvent(event);
  state.items.push({
    id: event.messageId,
    role: "tool",
    toolCallId: event.toolCallId,
    content: content ?? "",
    ...(failed ? { error: content ?? "Tool call failed" } : {}),
  });
  return true;
}

function isFailedToolResultEvent(event: ToolCallResultEvent): boolean {
  const role = Reflect.get(event, "role");
  const isError = Reflect.get(event, "isError");
  const status = Reflect.get(event, "status");
  const error = Reflect.get(event, "error");
  return (
    role === "tool" ||
    isError === true ||
    status === "error" ||
    typeof error === "string"
  );
}

function isTerragonCustomPartEvent(event: BaseEvent): event is CustomEvent {
  const name = Reflect.get(event, "name");
  return (
    event.type === EventType.CUSTOM &&
    typeof name === "string" &&
    name === "terragon.data-part"
  );
}

export async function getNativeAgUiHistoryMessagesForThreadChat({
  db,
  threadChatId,
}: {
  db: Pick<DB, "query">;
  threadChatId: string;
}): Promise<Message[]> {
  const envelopes = await getAgUiEventEnvelopesForThreadChat({
    db,
    threadChatId,
  });
  return getNativeAgUiHistoryMessagesFromEvents(
    envelopes.map((envelope) => envelope.payload),
  );
}

export async function hasNativeAgUiUserMessage({
  db,
  threadChatId,
}: {
  db: Pick<DB, "query">;
  threadChatId: string;
}): Promise<boolean> {
  const envelopes = await getAgUiEventEnvelopesForThreadChat({
    db,
    threadChatId,
  });
  return envelopes.some((envelope) => {
    const event = envelope.payload;
    return (
      event.type === EventType.MESSAGES_SNAPSHOT &&
      (event as MessagesSnapshotEvent).messages.some(
        (message) =>
          message.role === "user" &&
          messageContentToText(message.content).length > 0,
      )
    );
  });
}

export async function getLatestNativeAgUiSnapshotMessage({
  db,
  threadChatId,
}: {
  db: Pick<DB, "query">;
  threadChatId: string;
}): Promise<NativeAgUiSnapshotMessage | null> {
  const envelopes = await getAgUiEventEnvelopesForThreadChat({
    db,
    threadChatId,
  });
  let latest: NativeAgUiSnapshotMessage | null = null;
  for (const envelope of envelopes) {
    const event = envelope.payload;
    if (event.type !== EventType.MESSAGES_SNAPSHOT) {
      continue;
    }
    for (const message of (event as MessagesSnapshotEvent).messages) {
      const content = messageContentToText(message.content);
      if (message.role === "user") {
        latest = { role: "user", content };
      } else if (message.role === "system") {
        latest = {
          role: "system",
          messageType: systemMessageTypeFromId(message.id) ?? "unknown",
          content,
        };
      }
    }
  }
  return latest;
}

function userMessageToAgUiMessage(
  message: DBUserMessage,
  index: number,
): Message {
  const metadata = new URLSearchParams();
  if (message.model) {
    metadata.set("model", message.model);
  }
  if (message.permissionMode) {
    metadata.set("permissionMode", message.permissionMode);
  }
  const metadataName = metadata.toString();
  return {
    id: messageId({ type: "user", index, timestamp: message.timestamp }),
    role: "user",
    content: extractUserMessageText(message),
    ...(metadataName.length > 0
      ? { name: `terragon-user:${metadataName}` }
      : {}),
  };
}

function systemMessageToAgUiMessage(
  message: DBSystemMessage,
  index: number,
): Message | null {
  if (
    !NATIVE_AG_UI_SIDE_EFFECT_SYSTEM_MESSAGE_TYPES.has(
      message.message_type as NativeAgUiSideEffectSystemMessageType,
    )
  ) {
    return null;
  }
  const content = message.parts
    .map((part) => part.text)
    .filter((text) => text.length > 0)
    .join("\n");
  return {
    id: messageId({
      type: `system:${message.message_type}`,
      index,
      timestamp: message.timestamp,
    }),
    role: "system",
    content: content || `[${message.message_type}]`,
  };
}

function errorMessageToAgUiMessage(
  message: Extract<DBMessage, { type: "error" }>,
  index: number,
): Message {
  const content = [message.error_type, message.error_info]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join(": ");
  return {
    id: messageId({
      type: "system:error",
      index,
      timestamp: message.timestamp,
    }),
    role: "system",
    content: content || "[error]",
  };
}

function toolResultMessageToAgUiMessage(
  message: Extract<DBMessage, { type: "tool-result" }>,
  index: number,
): Message {
  const status = message.is_error ? "failed" : "completed";
  return {
    id: messageId({ type: `system:tool-result:${message.id}`, index }),
    role: "system",
    content: `Tool ${message.id} ${status}: ${message.result}`,
  };
}

function isContextResetMessage(message: Message): boolean {
  return (
    message.role === "system" &&
    message.id.startsWith("side-effect-system:compact-result-")
  );
}

function systemMessageTypeFromId(
  messageIdValue: string,
): NativeAgUiSnapshotSystemMessageType | null {
  if (messageIdValue.startsWith("side-effect-system:error-")) {
    return "error";
  }
  if (messageIdValue.startsWith("side-effect-system:tool-result:")) {
    return "tool-result";
  }
  const prefix = "side-effect-system:";
  if (!messageIdValue.startsWith(prefix)) {
    return null;
  }
  const withoutPrefix = messageIdValue.slice(prefix.length);
  const match = /^(?<messageType>.+)-\d+-[a-f0-9]{12}$/.exec(withoutPrefix);
  const messageType = match?.groups?.messageType;
  if (!messageType) {
    return null;
  }
  switch (messageType) {
    case "cancel-schedule":
    case "fix-github-checks":
    case "retry-git-commit-and-push":
    case "generic-retry":
    case "invalid-token-retry":
    case "clear-context":
    case "compact-result":
    case "agent-error-retry":
    case "follow-up-retry-failed":
      return messageType;
    default:
      return "unknown";
  }
}

function messageContentToText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (
        part !== null &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}

function extractUserMessageText(message: DBUserMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "rich-text") return extractRichText(part);
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function extractRichText(part: DBRichTextPart): string {
  return part.nodes.map((node) => node.text).join("");
}

function messageId(params: {
  type: string;
  index: number;
  timestamp?: string;
}): string {
  const hash = stableHash(params).slice(0, 12);
  return `side-effect-${params.type}-${params.index}-${hash}`;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
