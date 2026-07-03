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

export type DurableAgUiHistoryItem = Message | CustomEvent;

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
  const toolResult: DurableAgUiHistoryItem = {
    id: event.messageId,
    role: "tool",
    toolCallId: event.toolCallId,
    content: content ?? "",
    ...(failed ? { error: content ?? "Tool call failed" } : {}),
  };
  // Live command output (Codex stdout / MCP progress) arrives as repeated
  // cumulative TOOL_CALL_RESULT events for one tool, capped by the terminal
  // result. Collapse them to a single history row (last wins) so resume history
  // doesn't grow a tool-result item per output chunk.
  const existingIndex = state.items.findIndex(
    (item) =>
      "role" in item &&
      item.role === "tool" &&
      item.toolCallId === event.toolCallId,
  );
  if (existingIndex >= 0) {
    state.items[existingIndex] = toolResult;
  } else {
    state.items.push(toolResult);
  }
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
    (name === "terragon.data-part" || name === "terragon.part")
  );
}

function isContextResetMessage(message: Message): boolean {
  return (
    message.role === "system" &&
    message.id.startsWith("side-effect-system:compact-result-")
  );
}
