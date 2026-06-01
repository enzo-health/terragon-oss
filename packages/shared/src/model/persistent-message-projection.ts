import {
  type BaseEvent,
  type CustomEvent,
  EventType,
  type Message,
  type MessagesSnapshotEvent,
  type TextMessageChunkEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
} from "@ag-ui/core";
import { mapCanonicalEventToAgui } from "@terragon/agent/ag-ui-mapper";
import {
  type CanonicalEvent,
  CanonicalEventSchema,
} from "@terragon/agent/canonical-events";
import { AIModelSchema } from "@terragon/agent/types";
import type {
  DBMessage,
  DBSystemMessage,
  DBToolCall,
  DBUserMessage,
} from "../db/db-message";

export type DurableAgUiHistoryItem = Message | CustomEvent;

export type ProjectionReplayEntry = {
  seq: number;
  messages: DBMessage[];
};

type AgUiEventEnvelopeIdentity = {
  eventId: string;
  threadId: string;
  timestamp: string;
  idempotencyKey: string;
};

export type AgUiEventEnvelope<
  TEvent extends BaseEvent = BaseEvent,
  TIdentity extends "legacy" | "full" = "legacy",
> = (TIdentity extends "full"
  ? AgUiEventEnvelopeIdentity
  : Partial<AgUiEventEnvelopeIdentity>) & {
  seq: number;
  projectionIndex?: number;
  projectionCount?: number;
  runId: string;
  threadChatId: string;
  payload: TEvent;
};

export type AgUiReadableRow = {
  eventId: string;
  runId: string;
  threadId: string;
  threadChatId: string;
  seq: number;
  eventType: string;
  payloadJson: Record<string, unknown>;
  idempotencyKey: string;
  timestamp: Date;
};

type DBAgentMessageLike = Extract<DBMessage, { type: "agent" }>;
type DBDelegationMessageLike = Extract<DBMessage, { type: "delegation" }>;
type DBToolResultLike = Extract<DBMessage, { type: "tool-result" }>;

const AG_UI_EVENT_TYPES: ReadonlySet<unknown> = new Set(
  Object.values(EventType),
);

export type DbMessagesToAgUiOptions = {
  includeAssistantHistory?: boolean;
};

export function dbMessagesToAgUiMessages(
  dbMessages: DBMessage[],
  options?: DbMessagesToAgUiOptions,
): Message[] {
  const out: Message[] = [];
  let idSeq = 0;
  const nextId = () => `hydrate-${idSeq++}`;
  const includeAssistantHistory = options?.includeAssistantHistory ?? true;

  for (const msg of dbMessages) {
    switch (msg.type) {
      case "user":
        out.push(userMessageToAgUi(msg, nextId()));
        break;
      case "agent":
        if (!includeAssistantHistory) break;
        out.push(agentMessageToAgUi(msg, nextId()));
        break;
      case "tool-call":
        if (!includeAssistantHistory) break;
        out.push(toolCallToAgUi(msg, nextId()));
        break;
      case "tool-result":
        if (!includeAssistantHistory) break;
        out.push(toolResultToAgUi(msg, nextId()));
        break;
      case "system":
        out.push(systemMessageToAgUi(msg, nextId()));
        break;
      case "delegation":
        if (!includeAssistantHistory) break;
        out.push(delegationMessageToAgUi(msg, nextId()));
        break;
      case "git-diff":
      case "stop":
      case "error":
      case "meta":
      case "thread-context":
      case "thread-context-result":
        break;
      default:
        const _exhaustiveCheck: never = msg;
        void _exhaustiveCheck;
        break;
    }
  }

  return out;
}

function userMessageToAgUi(msg: DBUserMessage, id: string): Message {
  const content = msg.parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "rich-text") {
        return extractRichText(part);
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");

  return {
    id,
    role: "user",
    content,
  };
}

function agentMessageToAgUi(msg: DBAgentMessageLike, id: string): Message {
  const content = msg.parts
    .map((part) => {
      if (part.type === "text") return part.text;
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");

  return {
    id,
    role: "assistant",
    content,
  };
}

function delegationMessageToAgUi(
  msg: DBDelegationMessageLike,
  id: string,
): Message {
  return {
    id,
    role: "assistant",
    content: `Delegation ${msg.status}: ${msg.prompt}`,
  };
}

function toolCallToAgUi(msg: DBToolCall, id: string): Message {
  const argsJson = (() => {
    try {
      return JSON.stringify(msg.parameters ?? {});
    } catch {
      return "{}";
    }
  })();

  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: msg.id,
        type: "function" as const,
        function: {
          name: msg.name,
          arguments: argsJson,
        },
      },
    ],
  };
}

function toolResultToAgUi(msg: DBToolResultLike, id: string): Message {
  return {
    id,
    role: "tool",
    content: msg.result,
    toolCallId: msg.id,
    ...(msg.is_error ? { error: msg.result } : {}),
  };
}

function systemMessageToAgUi(msg: DBSystemMessage, id: string): Message {
  const content = msg.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");

  return {
    id,
    role: "system",
    content: content || `[${msg.message_type}]`,
  };
}

function extractRichText(part: { nodes: unknown[] }): string {
  const out: string[] = [];
  for (const node of part.nodes) {
    if (!node || typeof node !== "object") continue;
    const text = Reflect.get(node, "text");
    if (typeof text === "string") out.push(text);
  }
  return out.join("");
}

function isAgUiBaseEvent(payload: unknown): payload is BaseEvent {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const type = Reflect.get(payload, "type");
  return typeof type === "string" && AG_UI_EVENT_TYPES.has(type);
}

export function readAgUiPayload(row: AgUiReadableRow): BaseEvent | null {
  if (isAgUiBaseEvent(row.payloadJson)) {
    return row.payloadJson;
  }

  const canonical = CanonicalEventSchema.safeParse(row.payloadJson);
  if (canonical.success) {
    const [first] = mapCanonicalEventToAgui(canonical.data);
    return first ?? null;
  }

  console.warn(
    "[persistent-message-projection] readAgUiPayload: unrecognized payload shape",
    {
      eventId: row.eventId,
      runId: row.runId,
      eventType: row.eventType,
    },
  );
  return null;
}

function toAgUiEventEnvelope({
  row,
  payload,
  projectionIndex,
  projectionCount,
}: {
  row: Pick<
    AgUiReadableRow,
    | "eventId"
    | "seq"
    | "runId"
    | "threadId"
    | "threadChatId"
    | "idempotencyKey"
    | "timestamp"
  >;
  payload: BaseEvent;
  projectionIndex?: number;
  projectionCount?: number;
}): AgUiEventEnvelope<BaseEvent, "full"> {
  return {
    eventId: row.eventId,
    seq: row.seq,
    projectionIndex,
    projectionCount,
    runId: row.runId,
    threadId: row.threadId,
    threadChatId: row.threadChatId,
    timestamp: row.timestamp.toISOString(),
    idempotencyKey: row.idempotencyKey,
    payload,
  };
}

export function readAgUiEnvelope(
  row: AgUiReadableRow,
): AgUiEventEnvelope<BaseEvent, "full"> | null {
  const payload = readAgUiPayload(row);
  if (payload === null) {
    return null;
  }
  return toAgUiEventEnvelope({
    row,
    payload,
    projectionIndex: 0,
    projectionCount: 1,
  });
}

export function readAllAgUiPayloads(
  row: Pick<AgUiReadableRow, "payloadJson">,
): BaseEvent[] {
  if (isAgUiBaseEvent(row.payloadJson)) {
    return [row.payloadJson];
  }

  const canonical = CanonicalEventSchema.safeParse(row.payloadJson);
  if (canonical.success) {
    return mapCanonicalEventToAgui(canonical.data);
  }

  return [];
}

export function readAllAgUiEnvelopes(
  row: Pick<
    AgUiReadableRow,
    | "eventId"
    | "seq"
    | "runId"
    | "threadId"
    | "threadChatId"
    | "idempotencyKey"
    | "timestamp"
    | "payloadJson"
  >,
): Array<AgUiEventEnvelope<BaseEvent, "full">> {
  const payloads = readAllAgUiPayloads(row);
  return payloads.map((payload, projectionIndex) =>
    toAgUiEventEnvelope({
      row,
      payload,
      projectionIndex,
      projectionCount: payloads.length,
    }),
  );
}

export function canonicalEventToReplayMessage(
  event: CanonicalEvent,
): DBMessage | null {
  switch (event.type) {
    case "assistant-message":
      return {
        type: "agent",
        parent_tool_use_id: event.parentToolUseId ?? null,
        parts: [{ type: "text", text: event.content }],
      };
    case "tool-call-start":
      return {
        type: "tool-call",
        id: event.toolCallId,
        name: event.name,
        parameters: event.parameters,
        parent_tool_use_id: event.parentToolUseId ?? null,
        status: "started",
      };
    case "tool-call-result":
      return {
        type: "tool-result",
        id: event.toolCallId,
        is_error: event.isError,
        parent_tool_use_id: null,
        result: event.result,
      };
    case "run-started":
    case "run-terminal":
    case "tool-call-progress":
    case "reasoning-message":
    case "permission-request":
    case "permission-response":
    case "artifact-reference":
    case "meta":
    case "unknown-provider-event":
      return null;
    default: {
      const _exhaustiveCheck: never = event;
      return _exhaustiveCheck;
    }
  }
}

export function agUiSnapshotToReplayMessages(payload: unknown): DBMessage[] {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("type" in payload) ||
    payload.type !== EventType.MESSAGES_SNAPSHOT ||
    !("messages" in payload) ||
    !Array.isArray(payload.messages)
  ) {
    return [];
  }
  return payload.messages.flatMap((message) => {
    if (!isAgUiMessage(message)) {
      return [];
    }
    const replayMessage = agUiMessageToReplayMessage(message);
    return replayMessage ? [replayMessage] : [];
  });
}

export function applyContextResetToReplayEntries<
  TEntry extends ProjectionReplayEntry,
>(entries: TEntry[]): TEntry[] {
  const resetEntries: TEntry[] = [];

  for (const entry of entries) {
    let messagesForEntry: DBMessage[] = [];
    for (const message of entry.messages) {
      if (isContextResetReplayMessage(message)) {
        resetEntries.length = 0;
        messagesForEntry = [];
      }
      messagesForEntry.push(message);
    }
    if (messagesForEntry.length > 0) {
      resetEntries.push({ ...entry, messages: messagesForEntry });
    }
  }

  return resetEntries;
}

function messageContentToReplayText(content: Message["content"]): string {
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

function systemMessageTypeFromAgUiId(
  messageIdValue: string,
): Extract<DBMessage, { type: "system" }>["message_type"] | null {
  const prefix = "side-effect-system:";
  if (!messageIdValue.startsWith(prefix)) {
    return null;
  }
  const withoutPrefix = messageIdValue.slice(prefix.length);
  const match = /^(?<messageType>.+)-\d+-[a-f0-9]{12}$/.exec(withoutPrefix);
  const messageType = match?.groups?.messageType;
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
    case "snapshot-refresh-degraded":
      return messageType;
    default:
      const _exhaustiveCheck = messageType satisfies string | undefined;
      void _exhaustiveCheck;
      return null;
  }
}

function userMetadataFromAgUiName(
  name: string | undefined,
): Pick<Extract<DBMessage, { type: "user" }>, "model" | "permissionMode"> {
  if (!name?.startsWith("terragon-user:")) {
    return { model: null, permissionMode: undefined };
  }
  const metadata = new URLSearchParams(name.slice("terragon-user:".length));
  const modelResult = AIModelSchema.safeParse(metadata.get("model"));
  const permissionMode = metadata.get("permissionMode");
  return {
    model: modelResult.success ? modelResult.data : null,
    permissionMode:
      permissionMode === "allowAll" || permissionMode === "plan"
        ? permissionMode
        : undefined,
  };
}

function agUiMessageToReplayMessage(message: Message): DBMessage | null {
  const content = messageContentToReplayText(message.content);
  if (message.role === "user" && content.length > 0) {
    const metadata = userMetadataFromAgUiName(message.name);
    return {
      type: "user",
      model: metadata.model,
      ...(metadata.permissionMode
        ? { permissionMode: metadata.permissionMode }
        : {}),
      parts: [{ type: "text", text: content }],
    };
  }
  if (message.role !== "system") {
    return null;
  }
  const messageType = systemMessageTypeFromAgUiId(message.id);
  if (!messageType) {
    return null;
  }
  return {
    type: "system",
    message_type: messageType,
    parts: content.length > 0 ? [{ type: "text", text: content }] : [],
  };
}

function isAgUiMessage(value: unknown): value is Message {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const role = Reflect.get(value, "role");
  const id = Reflect.get(value, "id");
  const content = Reflect.get(value, "content");
  return (
    (role === "user" || role === "system" || role === "assistant") &&
    typeof id === "string" &&
    (content === null || typeof content === "string" || Array.isArray(content))
  );
}

function isContextResetReplayMessage(message: DBMessage): boolean {
  return message.type === "system" && message.message_type === "compact-result";
}

export function getDurableAgUiHistoryItemsFromEvents(
  events: readonly BaseEvent[],
): { items: DurableAgUiHistoryItem[]; lastSeqOffset: number } {
  const state = createHistoryBuilderState();
  let representedRunActivity = false;

  events.forEach((event, index) => {
    const effect = applyHistoryEvent(state, event);
    const shouldAdvanceCursor =
      effect.changed ||
      (effect.runActivity === "completed" && representedRunActivity);

    if (shouldAdvanceCursor) {
      state.lastSeqOffset = index;
    }
    switch (effect.runActivity) {
      case "reset":
      case "completed":
        representedRunActivity = false;
        break;
      case "represented":
        representedRunActivity = true;
        break;
      case "none":
        break;
    }
  });

  return {
    items: state.items,
    lastSeqOffset: state.lastSeqOffset,
  };
}

type HistoryBuilderState = {
  items: DurableAgUiHistoryItem[];
  itemIds: Set<string>;
  assistantById: Map<string, Extract<Message, { role: "assistant" }>>;
  toolCallById: Map<
    string,
    NonNullable<Extract<Message, { role: "assistant" }>["toolCalls"]>[number]
  >;
  toolParentById: Map<string, string>;
  unresolvedToolCallIds: Set<string>;
  lastAssistantId: string | null;
  lastSeqOffset: number;
};

function createHistoryBuilderState(): HistoryBuilderState {
  return {
    items: [],
    itemIds: new Set(),
    assistantById: new Map(),
    toolCallById: new Map(),
    toolParentById: new Map(),
    unresolvedToolCallIds: new Set(),
    lastAssistantId: null,
    lastSeqOffset: -1,
  };
}

type HistoryRunActivity = "none" | "reset" | "represented" | "completed";

type HistoryEventEffect = {
  changed: boolean;
  runActivity: HistoryRunActivity;
};

function historyEventEffect(
  changed: boolean,
  runActivity: HistoryRunActivity = changed ? "represented" : "none",
): HistoryEventEffect {
  return { changed, runActivity };
}

function applyHistoryEvent(
  state: HistoryBuilderState,
  event: BaseEvent,
): HistoryEventEffect {
  switch (event.type) {
    case EventType.RUN_STARTED:
      return historyEventEffect(false, "reset");
    case EventType.MESSAGES_SNAPSHOT: {
      const snapshotEffect = applyMessagesSnapshot(
        state,
        event as MessagesSnapshotEvent,
      );
      return historyEventEffect(
        snapshotEffect.changed,
        snapshotEffect.resetsRunActivity ? "reset" : "none",
      );
    }
    case EventType.TEXT_MESSAGE_START:
      return historyEventEffect(
        startTextHistoryMessage(state, event as TextMessageStartEvent),
      );
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_CHUNK:
      return historyEventEffect(
        appendTextHistoryMessage(
          state,
          event as TextMessageContentEvent | TextMessageChunkEvent,
        ),
      );
    case EventType.TEXT_MESSAGE_END:
      return historyEventEffect(
        finishTextHistoryMessage(state, event as TextMessageEndEvent),
      );
    case EventType.TOOL_CALL_START:
      return historyEventEffect(
        startHistoryToolCall(state, event as ToolCallStartEvent),
      );
    case EventType.TOOL_CALL_ARGS:
    case EventType.TOOL_CALL_CHUNK:
      return historyEventEffect(
        appendHistoryToolArgs(state, event as ToolCallArgsEvent),
      );
    case EventType.TOOL_CALL_END:
      return historyEventEffect(
        finishHistoryToolCall(state, event as ToolCallEndEvent),
      );
    case EventType.TOOL_CALL_RESULT:
      return historyEventEffect(
        addHistoryToolResult(state, event as ToolCallResultEvent),
      );
    case EventType.CUSTOM:
      if (isTerragonCustomPartEvent(event)) {
        state.items.push(event);
        return historyEventEffect(true);
      }
      return historyEventEffect(false);
    case EventType.RUN_FINISHED:
      return historyEventEffect(
        finishUnresolvedHistoryToolCalls(
          state,
          "Tool call ended without a result.",
        ),
        "completed",
      );
    case EventType.RUN_ERROR:
      return historyEventEffect(
        finishUnresolvedHistoryToolCalls(state, historyRunErrorMessage(event)),
        "completed",
      );
    default:
      return historyEventEffect(false);
  }
}

type MessagesSnapshotHistoryEffect = {
  changed: boolean;
  resetsRunActivity: boolean;
};

function applyMessagesSnapshot(
  state: HistoryBuilderState,
  event: MessagesSnapshotEvent,
): MessagesSnapshotHistoryEffect {
  let changed = false;
  let resetsRunActivity = false;
  for (const message of event.messages) {
    if (isEmptyAssistantMessage(message)) {
      continue;
    }
    if (isContextResetMessage(message)) {
      resetsRunActivity = true;
      changed =
        changed ||
        state.items.length > 0 ||
        state.assistantById.size > 0 ||
        state.toolCallById.size > 0 ||
        state.toolParentById.size > 0 ||
        state.lastAssistantId !== null;
      state.items.length = 0;
      state.itemIds.clear();
      state.assistantById.clear();
      state.toolCallById.clear();
      state.toolParentById.clear();
      state.unresolvedToolCallIds.clear();
      state.lastAssistantId = null;
      continue;
    }
    if (state.itemIds.has(message.id)) {
      continue;
    }
    state.items.push(message);
    state.itemIds.add(message.id);
    indexHistoryMessage(state, message);
    changed = true;
  }
  return { changed, resetsRunActivity };
}

function indexHistoryMessage(
  state: HistoryBuilderState,
  message: Message,
): void {
  if (message.role === "tool") {
    state.unresolvedToolCallIds.delete(message.toolCallId);
    return;
  }
  if (message.role !== "assistant") {
    return;
  }
  state.assistantById.set(message.id, message);
  state.lastAssistantId = message.id;
  for (const toolCall of message.toolCalls ?? []) {
    state.toolCallById.set(toolCall.id, toolCall);
    state.toolParentById.set(toolCall.id, message.id);
    state.unresolvedToolCallIds.add(toolCall.id);
  }
}

function isEmptyAssistantMessage(message: Message): boolean {
  return (
    message.role === "assistant" &&
    (message.content ?? "").length === 0 &&
    (message.toolCalls?.length ?? 0) === 0
  );
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
  state.itemIds.add(messageId);
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
  state.lastAssistantId = event.messageId;
  return false;
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
  state: HistoryBuilderState,
  event: TextMessageEndEvent,
): boolean {
  return state.assistantById.has(event.messageId);
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
  state.unresolvedToolCallIds.add(event.toolCallId);
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
  state: HistoryBuilderState,
  event: ToolCallEndEvent,
): boolean {
  return state.toolCallById.has(event.toolCallId);
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
  state.unresolvedToolCallIds.delete(event.toolCallId);
  return true;
}

function finishUnresolvedHistoryToolCalls(
  state: HistoryBuilderState,
  content: string,
): boolean {
  let changed = false;
  for (const toolCallId of state.unresolvedToolCallIds) {
    state.items.push({
      id: `${toolCallId}:unresolved-result`,
      role: "tool",
      toolCallId,
      content,
      error: content,
    });
    changed = true;
  }
  state.unresolvedToolCallIds.clear();
  return changed;
}

function historyRunErrorMessage(event: BaseEvent): string {
  const message = Reflect.get(event, "message");
  return typeof message === "string" && message.length > 0
    ? message
    : "Run ended before this tool returned a result.";
}

function isFailedToolResultEvent(event: ToolCallResultEvent): boolean {
  const isError = Reflect.get(event, "isError");
  const status = Reflect.get(event, "status");
  const error = Reflect.get(event, "error");
  return isError === true || status === "error" || typeof error === "string";
}

function isTerragonCustomPartEvent(event: BaseEvent): event is CustomEvent {
  const name = Reflect.get(event, "name");
  return (
    event.type === EventType.CUSTOM &&
    typeof name === "string" &&
    name === "terragon.data-part"
  );
}

function isContextResetMessage(message: Message): boolean {
  return (
    message.role === "system" &&
    message.id.startsWith("side-effect-system:compact-result-")
  );
}
