import { EventType, type BaseEvent, type Message } from "@ag-ui/core";
import {
  createInitialTranscriptState,
  type AttachmentItem,
  type DelegationActivity,
  type DelegationItem,
  type DiffChangeKind,
  type DiffItem,
  type ErrorItem,
  type ImageItem,
  type PermissionItem,
  type PermissionOption,
  type PlanEntry,
  type PlanItem,
  type ReasoningItem,
  type RunState,
  type RunStatus,
  type SourceEntry,
  type SourcesItem,
  type TerminalChunk,
  type TerminalItem,
  type TextItem,
  type ToolCallStatus,
  type ToolItem,
  type TranscriptEnvelope,
  type TranscriptItem,
  type TranscriptState,
  type UnknownPartItem,
  type UnknownPartSource,
  type UserContentPart,
  type UserItem,
} from "./transcript-item";

const CONTEXT_RESET_ID_PREFIX = "side-effect-system:compact-result-";
const UNRESOLVED_TOOL_RESULT = "Tool call ended without a result.";
const DATA_PART_EVENT_NAME = "terragon.data-part";
const RICH_PART_EVENT_NAME = "terragon.part";

const META_CUSTOM_NAMES = new Set([
  "thread.status_changed",
  "artifact-reference",
]);
const META_CUSTOM_VALUE_KINDS = new Set([
  "thread.token_usage_updated",
  "account.rate_limits_updated",
  "model.rerouted",
  "mcp_server.startup_status_updated",
]);

const IGNORED_EVENT_TYPES = new Set<string>([
  EventType.STEP_STARTED,
  EventType.STEP_FINISHED,
  EventType.STATE_SNAPSHOT,
  EventType.STATE_DELTA,
  EventType.ACTIVITY_SNAPSHOT,
  EventType.ACTIVITY_DELTA,
  EventType.RAW,
  EventType.THINKING_START,
  EventType.THINKING_END,
  EventType.REASONING_START,
  EventType.REASONING_END,
  EventType.REASONING_ENCRYPTED_VALUE,
]);

type Draft = {
  items: TranscriptItem[];
  index: Record<string, number>;
  versions: Record<string, number>;
  seenEventKeys: Set<string>;
  runs: Record<string, RunState>;
  currentRunId: string | null;
  nextSeq: number;
  changed: boolean;
};

function toDraft(state: TranscriptState): Draft {
  return {
    items: [...state.items],
    index: { ...state.index },
    versions: { ...state.versions },
    seenEventKeys: new Set(state.seenEventKeys),
    runs: { ...state.runs },
    currentRunId: state.currentRunId,
    nextSeq: state.nextSeq,
    changed: false,
  };
}

function finalize(state: TranscriptState, draft: Draft): TranscriptState {
  if (!draft.changed) {
    return state;
  }
  return {
    items: draft.items,
    index: draft.index,
    versions: draft.versions,
    seenEventKeys: draft.seenEventKeys,
    runs: draft.runs,
    currentRunId: draft.currentRunId,
    nextSeq: draft.nextSeq,
    revision: state.revision + 1,
  };
}

function getItem<T extends TranscriptItem>(
  draft: Draft,
  key: string,
): T | undefined {
  const position = draft.index[key];
  if (position === undefined) return undefined;
  return draft.items[position] as T;
}

function insertItem(draft: Draft, item: TranscriptItem): void {
  draft.index[item.key] = draft.items.length;
  draft.items.push(item);
  draft.versions[item.key] = 1;
  draft.changed = true;
}

function replaceItem(draft: Draft, item: TranscriptItem): void {
  const position = draft.index[item.key];
  if (position === undefined) {
    insertItem(draft, item);
    return;
  }
  draft.items[position] = item;
  draft.versions[item.key] = (draft.versions[item.key] ?? 0) + 1;
  draft.changed = true;
}

function nextSeqValue(draft: Draft, envelope: TranscriptEnvelope): number {
  if (typeof envelope.seq === "number") {
    return envelope.seq;
  }
  const value = draft.nextSeq;
  draft.nextSeq += 1;
  return value;
}

function eventField(event: BaseEvent, key: string): unknown {
  return Reflect.get(event, key);
}

function stringField(event: BaseEvent, key: string): string | null {
  const value = eventField(event, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readString(source: unknown, key: string): string | null {
  if (!source || typeof source !== "object") return null;
  const value = Reflect.get(source, key);
  return typeof value === "string" ? value : null;
}

function readNumber(source: unknown, key: string): number | null {
  if (!source || typeof source !== "object") return null;
  const value = Reflect.get(source, key);
  return typeof value === "number" ? value : null;
}

export function applyAgUiEvent(
  state: TranscriptState,
  envelope: TranscriptEnvelope,
): TranscriptState {
  const event = envelope.payload;
  const runId = envelope.runId ?? state.currentRunId ?? null;

  if (typeof envelope.eventId === "string") {
    const dedupeKey = `${runId ?? ""}:${envelope.eventId}`;
    if (state.seenEventKeys.has(dedupeKey)) {
      return state;
    }
    const draft = toDraft(state);
    draft.seenEventKeys.add(dedupeKey);
    draft.changed = true;
    routeEvent(draft, envelope, event, runId);
    return finalize(state, draft);
  }

  const draft = toDraft(state);
  routeEvent(draft, envelope, event, runId);
  return finalize(state, draft);
}

function routeEvent(
  draft: Draft,
  envelope: TranscriptEnvelope,
  event: BaseEvent,
  runId: string | null,
): void {
  switch (event.type) {
    case EventType.RUN_STARTED:
      return handleRunStarted(draft, event);
    case EventType.RUN_FINISHED:
      return handleRunFinished(draft, event, runId);
    case EventType.RUN_ERROR:
      return handleRunError(draft, event, runId);
    case EventType.TEXT_MESSAGE_START:
      return handleTextStart(draft, envelope, event, runId);
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_CHUNK:
      return handleTextContent(draft, envelope, event, runId);
    case EventType.TEXT_MESSAGE_END:
      return handleTextEnd(draft, event);
    case EventType.REASONING_MESSAGE_START:
    case EventType.THINKING_TEXT_MESSAGE_START:
      return handleReasoningStart(draft, envelope, event, runId);
    case EventType.REASONING_MESSAGE_CONTENT:
    case EventType.REASONING_MESSAGE_CHUNK:
    case EventType.THINKING_TEXT_MESSAGE_CONTENT:
      return handleReasoningContent(draft, envelope, event, runId);
    case EventType.REASONING_MESSAGE_END:
    case EventType.THINKING_TEXT_MESSAGE_END:
      return handleReasoningEnd(draft, event);
    case EventType.TOOL_CALL_START:
      return handleToolStart(draft, envelope, event, runId);
    case EventType.TOOL_CALL_ARGS:
      return handleToolArgs(draft, event);
    case EventType.TOOL_CALL_CHUNK:
      return handleToolChunk(draft, event);
    case EventType.TOOL_CALL_END:
      return handleToolEnd(draft, event);
    case EventType.TOOL_CALL_RESULT:
      return handleToolResult(draft, envelope, event, runId);
    case EventType.MESSAGES_SNAPSHOT:
      return handleMessagesSnapshot(draft, envelope, event, runId);
    case EventType.CUSTOM:
      return handleCustom(draft, envelope, event, runId);
    default:
      return handleUnknownEvent(draft, envelope, event, runId);
  }
}

function upsertRun(draft: Draft, runId: string, next: RunState): void {
  const existing = draft.runs[runId];
  if (
    existing &&
    existing.status === next.status &&
    existing.errorMessage === next.errorMessage
  ) {
    return;
  }
  draft.runs[runId] = next;
  draft.changed = true;
}

function handleRunStarted(draft: Draft, event: BaseEvent): void {
  const runId = stringField(event, "runId");
  if (!runId) return;
  draft.currentRunId = runId;
  draft.changed = true;
  upsertRun(draft, runId, { runId, status: "running", errorMessage: null });
}

function finalizeStreamingItems(draft: Draft): void {
  for (let position = 0; position < draft.items.length; position += 1) {
    const item = draft.items[position]!;
    if ((item.kind === "text" || item.kind === "reasoning") && item.streaming) {
      replaceItem(draft, { ...item, streaming: false });
    }
  }
}

function finalizeUnresolvedTools(draft: Draft, resultText: string): void {
  for (let position = 0; position < draft.items.length; position += 1) {
    const item = draft.items[position]!;
    if (item.kind === "tool" && item.result === null) {
      replaceItem(draft, {
        ...item,
        result: resultText,
        isError: true,
        status: "error",
        streamingArgs: false,
      });
    }
  }
}

function terminalRunStatus(
  draft: Draft,
  runId: string,
  status: RunStatus,
): void {
  upsertRun(draft, runId, {
    runId,
    status,
    errorMessage: draft.runs[runId]?.errorMessage ?? null,
  });
}

function handleRunFinished(
  draft: Draft,
  event: BaseEvent,
  runId: string | null,
): void {
  const resolvedRunId = stringField(event, "runId") ?? runId;
  const result = eventField(event, "result");
  const stopped =
    typeof result === "object" &&
    result !== null &&
    Reflect.get(result, "stopped") === true;
  if (resolvedRunId) {
    terminalRunStatus(draft, resolvedRunId, stopped ? "stopped" : "completed");
  }
  finalizeStreamingItems(draft);
  finalizeUnresolvedTools(draft, UNRESOLVED_TOOL_RESULT);
}

function handleRunError(
  draft: Draft,
  event: BaseEvent,
  runId: string | null,
): void {
  const resolvedRunId = stringField(event, "runId") ?? runId;
  const message =
    stringField(event, "message") ??
    "Run ended before this tool returned a result.";
  if (resolvedRunId) {
    upsertRun(draft, resolvedRunId, {
      runId: resolvedRunId,
      status: "error",
      errorMessage: message,
    });
  }
  finalizeStreamingItems(draft);
  finalizeUnresolvedTools(draft, message);
}

function ensureTextItem(
  draft: Draft,
  envelope: TranscriptEnvelope,
  messageId: string,
  runId: string | null,
): TextItem {
  const key = `text:${messageId}`;
  const existing = getItem<TextItem>(draft, key);
  if (existing) return existing;
  const item: TextItem = {
    kind: "text",
    key,
    runId,
    seq: nextSeqValue(draft, envelope),
    messageId,
    text: "",
    streaming: true,
  };
  insertItem(draft, item);
  return item;
}

function handleTextStart(
  draft: Draft,
  envelope: TranscriptEnvelope,
  event: BaseEvent,
  runId: string | null,
): void {
  const role = stringField(event, "role");
  if (role !== null && role !== "assistant") return;
  const messageId = stringField(event, "messageId");
  if (!messageId) return;
  const item = ensureTextItem(draft, envelope, messageId, runId);
  if (!item.streaming) {
    replaceItem(draft, { ...item, streaming: true });
  }
}

function handleTextContent(
  draft: Draft,
  envelope: TranscriptEnvelope,
  event: BaseEvent,
  runId: string | null,
): void {
  const messageId = stringField(event, "messageId");
  const delta = eventField(event, "delta");
  if (!messageId || typeof delta !== "string" || delta.length === 0) return;
  const item = ensureTextItem(draft, envelope, messageId, runId);
  replaceItem(draft, { ...item, text: item.text + delta, streaming: true });
}

function handleTextEnd(draft: Draft, event: BaseEvent): void {
  const messageId = stringField(event, "messageId");
  if (!messageId) return;
  const item = getItem<TextItem>(draft, `text:${messageId}`);
  if (item && item.streaming) {
    replaceItem(draft, { ...item, streaming: false });
  }
}

function ensureReasoning(
  draft: Draft,
  envelope: TranscriptEnvelope,
  messageId: string,
  runId: string | null,
): ReasoningItem {
  const key = `reasoning:${messageId}`;
  const existing = getItem<ReasoningItem>(draft, key);
  if (existing) return existing;
  const item: ReasoningItem = {
    kind: "reasoning",
    key,
    runId,
    seq: nextSeqValue(draft, envelope),
    messageId,
    text: "",
    streaming: true,
    steps: [],
  };
  insertItem(draft, item);
  return item;
}

function handleReasoningStart(
  draft: Draft,
  envelope: TranscriptEnvelope,
  event: BaseEvent,
  runId: string | null,
): void {
  const messageId = stringField(event, "messageId");
  if (!messageId) return;
  const item = ensureReasoning(draft, envelope, messageId, runId);
  if (!item.streaming) {
    replaceItem(draft, { ...item, streaming: true });
  }
}

function handleReasoningContent(
  draft: Draft,
  envelope: TranscriptEnvelope,
  event: BaseEvent,
  runId: string | null,
): void {
  const messageId = stringField(event, "messageId");
  const delta = eventField(event, "delta");
  if (!messageId || typeof delta !== "string" || delta.length === 0) return;
  const item = ensureReasoning(draft, envelope, messageId, runId);
  replaceItem(draft, { ...item, text: item.text + delta, streaming: true });
}

function handleReasoningEnd(draft: Draft, event: BaseEvent): void {
  const messageId = stringField(event, "messageId");
  if (!messageId) return;
  const item = getItem<ReasoningItem>(draft, `reasoning:${messageId}`);
  if (item && item.streaming) {
    replaceItem(draft, { ...item, streaming: false });
  }
}

function handleToolStart(
  draft: Draft,
  envelope: TranscriptEnvelope,
  event: BaseEvent,
  runId: string | null,
): void {
  const toolCallId = stringField(event, "toolCallId");
  if (!toolCallId) return;
  const key = `tool:${toolCallId}`;
  if (getItem(draft, key)) return;
  const item: ToolItem = {
    kind: "tool",
    key,
    runId,
    seq: nextSeqValue(draft, envelope),
    toolCallId,
    name: stringField(event, "toolCallName") ?? "",
    argsText: "",
    parsedArgs: undefined,
    result: null,
    isError: false,
    status: "running",
    streamingArgs: true,
    parentMessageId: stringField(event, "parentMessageId"),
  };
  insertItem(draft, item);
}

function ensureToolCall(
  draft: Draft,
  toolCallId: string,
): ToolItem | undefined {
  return getItem<ToolItem>(draft, `tool:${toolCallId}`);
}

function handleToolArgs(draft: Draft, event: BaseEvent): void {
  const toolCallId = stringField(event, "toolCallId");
  const delta = eventField(event, "delta");
  if (!toolCallId || typeof delta !== "string" || delta.length === 0) return;
  const item = ensureToolCall(draft, toolCallId);
  if (!item) return;
  const argsText = item.argsText + delta;
  replaceItem(draft, {
    ...item,
    argsText,
    parsedArgs: tryParseJson(argsText),
    streamingArgs: true,
  });
}

function handleToolChunk(draft: Draft, event: BaseEvent): void {
  const toolCallId = stringField(event, "toolCallId");
  const delta = eventField(event, "delta");
  if (!toolCallId || typeof delta !== "string" || delta.length === 0) return;
  const item = ensureToolCall(draft, toolCallId);
  if (!item) return;
  const progressKind = stringField(event, "progressKind");
  if (progressKind === null || progressKind === "args") {
    const argsText = item.argsText + delta;
    replaceItem(draft, {
      ...item,
      argsText,
      parsedArgs: tryParseJson(argsText),
      streamingArgs: true,
    });
    return;
  }
  replaceItem(draft, { ...item, result: (item.result ?? "") + delta });
}

function handleToolEnd(draft: Draft, event: BaseEvent): void {
  const toolCallId = stringField(event, "toolCallId");
  if (!toolCallId) return;
  const item = ensureToolCall(draft, toolCallId);
  if (!item || !item.streamingArgs) return;
  replaceItem(draft, { ...item, streamingArgs: false });
}

function isErrorResult(event: BaseEvent): boolean {
  return (
    eventField(event, "isError") === true ||
    eventField(event, "status") === "error" ||
    typeof eventField(event, "error") === "string"
  );
}

function toolResultStatus(failed: boolean): ToolCallStatus {
  return failed ? "error" : "success";
}

function handleToolResult(
  draft: Draft,
  envelope: TranscriptEnvelope,
  event: BaseEvent,
  runId: string | null,
): void {
  const toolCallId = stringField(event, "toolCallId");
  if (!toolCallId) return;
  const rawContent = eventField(event, "content");
  const content =
    typeof rawContent === "string"
      ? rawContent
      : rawContent === undefined
        ? ""
        : JSON.stringify(rawContent);
  const failed = isErrorResult(event);
  const existing = ensureToolCall(draft, toolCallId);
  if (existing) {
    replaceItem(draft, {
      ...existing,
      result: content,
      isError: failed,
      status: toolResultStatus(failed),
      streamingArgs: false,
    });
    return;
  }
  const key = `tool:${toolCallId}`;
  insertItem(draft, {
    kind: "tool",
    key,
    runId,
    seq: nextSeqValue(draft, envelope),
    toolCallId,
    name: "",
    argsText: "",
    parsedArgs: undefined,
    result: content,
    isError: failed,
    status: toolResultStatus(failed),
    streamingArgs: false,
    parentMessageId: null,
  });
}

function userContentFromMessage(message: Message): readonly UserContentPart[] {
  const content = Reflect.get(message, "content");
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((part): UserContentPart => {
    const type = readString(part, "type");
    if (type === "text") {
      return { type: "text", text: readString(part, "text") ?? "" };
    }
    if (type === "image" || type === "image_url") {
      return { type: "image", url: readString(part, "url") };
    }
    return { type: "unknown", raw: part };
  });
}

function clearItems(draft: Draft): void {
  if (draft.items.length === 0) return;
  draft.items = [];
  draft.index = {};
  draft.changed = true;
}

function handleMessagesSnapshot(
  draft: Draft,
  envelope: TranscriptEnvelope,
  event: BaseEvent,
  runId: string | null,
): void {
  const messages = eventField(event, "messages");
  if (!Array.isArray(messages)) return;
  for (const message of messages as Message[]) {
    applySnapshotMessage(draft, envelope, message, runId);
  }
}

function applySnapshotMessage(
  draft: Draft,
  envelope: TranscriptEnvelope,
  message: Message,
  runId: string | null,
): void {
  const role = Reflect.get(message, "role");
  const id = readString(message, "id");
  if (!id) return;

  if (role === "system" && id.startsWith(CONTEXT_RESET_ID_PREFIX)) {
    clearItems(draft);
    const key = `compaction:${id}`;
    if (!getItem(draft, key)) {
      insertItem(draft, {
        kind: "compaction",
        key,
        runId,
        seq: nextSeqValue(draft, envelope),
        compactionId: id,
      });
    }
    return;
  }

  if (role === "user") {
    const key = `user:${id}`;
    if (getItem(draft, key)) return;
    const item: UserItem = {
      kind: "user",
      key,
      runId,
      seq: nextSeqValue(draft, envelope),
      messageId: id,
      content: userContentFromMessage(message),
    };
    insertItem(draft, item);
    return;
  }

  if (role === "reasoning") {
    const key = `reasoning:${id}`;
    if (getItem(draft, key)) return;
    insertItem(draft, {
      kind: "reasoning",
      key,
      runId,
      seq: nextSeqValue(draft, envelope),
      messageId: id,
      text: readString(message, "content") ?? "",
      streaming: false,
      steps: [],
    });
    return;
  }

  if (role === "assistant") {
    applySnapshotAssistant(draft, envelope, message, id, runId);
    return;
  }

  if (role === "tool") {
    applySnapshotToolResult(draft, message);
    return;
  }
}

function applySnapshotAssistant(
  draft: Draft,
  envelope: TranscriptEnvelope,
  message: Message,
  id: string,
  runId: string | null,
): void {
  const content = readString(message, "content");
  const key = `text:${id}`;
  if (content && content.length > 0 && !getItem(draft, key)) {
    insertItem(draft, {
      kind: "text",
      key,
      runId,
      seq: nextSeqValue(draft, envelope),
      messageId: id,
      text: content,
      streaming: false,
    });
  }
  const toolCalls = Reflect.get(message, "toolCalls");
  if (!Array.isArray(toolCalls)) return;
  for (const toolCall of toolCalls) {
    const toolCallId = readString(toolCall, "id");
    if (!toolCallId) continue;
    const toolKey = `tool:${toolCallId}`;
    if (getItem(draft, toolKey)) continue;
    const fn = Reflect.get(toolCall, "function");
    const argsText = readString(fn, "arguments") ?? "";
    insertItem(draft, {
      kind: "tool",
      key: toolKey,
      runId,
      seq: nextSeqValue(draft, envelope),
      toolCallId,
      name: readString(fn, "name") ?? "",
      argsText,
      parsedArgs: tryParseJson(argsText),
      result: null,
      isError: false,
      status: "running",
      streamingArgs: false,
      parentMessageId: id,
    });
  }
}

function applySnapshotToolResult(draft: Draft, message: Message): void {
  const toolCallId = readString(message, "toolCallId");
  if (!toolCallId) return;
  const item = ensureToolCall(draft, toolCallId);
  const content = readString(message, "content") ?? "";
  const failed = typeof Reflect.get(message, "error") === "string";
  if (!item) return;
  replaceItem(draft, {
    ...item,
    result: content,
    isError: failed,
    status: toolResultStatus(failed),
    streamingArgs: false,
  });
}

function isMetaCustom(event: BaseEvent, name: string): boolean {
  if (META_CUSTOM_NAMES.has(name)) return true;
  const value = eventField(event, "value");
  const kind = readString(value, "kind");
  return kind !== null && META_CUSTOM_VALUE_KINDS.has(kind);
}

function handleCustom(
  draft: Draft,
  envelope: TranscriptEnvelope,
  event: BaseEvent,
  runId: string | null,
): void {
  const name = stringField(event, "name");
  if (!name) return;
  const value = eventField(event, "value");

  if (name === DATA_PART_EVENT_NAME) {
    handleDataPart(draft, envelope, value, runId);
    return;
  }
  if (name === RICH_PART_EVENT_NAME) {
    handleRichPart(draft, envelope, value, runId);
    return;
  }
  if (name === "thread.compacted") {
    const key = `compaction:${envelope.eventId ?? `seq-${draft.nextSeq}`}`;
    if (getItem(draft, key)) return;
    insertItem(draft, {
      kind: "compaction",
      key,
      runId,
      seq: nextSeqValue(draft, envelope),
      compactionId: key,
    });
    return;
  }
  if (isMetaCustom(event, name)) {
    return;
  }
  insertUnknownPart(draft, envelope, {
    key: `unknown:custom:${envelope.eventId ?? `seq-${draft.nextSeq}`}`,
    source: "event",
    name,
    data: value,
    runId,
  });
}

function handleUnknownEvent(
  draft: Draft,
  envelope: TranscriptEnvelope,
  event: BaseEvent,
  runId: string | null,
): void {
  const type = String(event.type);
  if (IGNORED_EVENT_TYPES.has(type)) return;
  insertUnknownPart(draft, envelope, {
    key: `unknown:event:${envelope.eventId ?? `seq-${draft.nextSeq}`}`,
    source: "event",
    name: type,
    data: event,
    runId,
  });
}

function handleDataPart(
  draft: Draft,
  envelope: TranscriptEnvelope,
  value: unknown,
  runId: string | null,
): void {
  if (!value || typeof value !== "object") return;
  const messageId = readString(value, "messageId") ?? "unknown";
  const partIndex = readNumber(value, "partIndex") ?? 0;
  const innerName = readString(value, "name") ?? "terragon.unknown";
  const richKind = innerName.startsWith("terragon.")
    ? innerName.slice("terragon.".length)
    : innerName;
  const data = Reflect.get(value, "data");
  const key = `part:${messageId}:${partIndex}`;
  routeRichPart(draft, envelope, richKind, innerName, data, key, runId);
}

function handleRichPart(
  draft: Draft,
  envelope: TranscriptEnvelope,
  value: unknown,
  runId: string | null,
): void {
  if (!value || typeof value !== "object") return;
  const richKind = readString(value, "richKind") ?? "unknown";
  const payload = Reflect.get(value, "payload");
  const messageId = readString(value, "messageId");
  const partIndex = readNumber(value, "partIndex");
  const key =
    messageId !== null
      ? `part:${messageId}:${partIndex ?? 0}`
      : `part:${envelope.eventId ?? `seq-${draft.nextSeq}`}`;
  routeRichPart(draft, envelope, richKind, richKind, payload, key, runId);
}

function routeRichPart(
  draft: Draft,
  envelope: TranscriptEnvelope,
  richKind: string,
  displayName: string,
  data: unknown,
  key: string,
  runId: string | null,
): void {
  const seq = getItem(draft, key)?.seq ?? nextSeqValue(draft, envelope);
  const item = richPartItem(richKind, displayName, key, data, runId, seq);
  replaceItem(draft, item);
}

function richPartItem(
  richKind: string,
  displayName: string,
  key: string,
  data: unknown,
  runId: string | null,
  seq: number,
): TranscriptItem {
  switch (richKind) {
    case "diff":
    case "acp-diff":
    case "codex-diff":
      return diffItem(key, data, runId, seq);
    case "plan":
    case "acp-plan":
    case "codex-plan":
      return planItem(key, data, runId, seq);
    case "terminal":
    case "acp-terminal":
      return terminalItem(key, data, runId, seq);
    case "image":
    case "acp-image":
      return imageItem(key, data, runId, seq);
    case "audio":
    case "acp-audio":
      return attachmentItem(key, data, runId, seq);
    case "resource-link":
    case "acp-resource-link":
      return attachmentItem(key, data, runId, seq);
    case "error":
    case "codex-error":
      return errorItem(key, data, runId, seq);
    case "auto-approval-review":
    case "codex-auto-approval-review":
    case "permission":
      return permissionItem(key, data, runId, seq);
    case "web-search":
    case "sources":
      return sourcesItem(key, data, runId, seq);
    case "delegation":
    case "collab":
    case "sub-agent":
    case "subAgentActivity":
      return delegationItem(key, data, runId, seq);
    case "compaction":
      return { kind: "compaction", key, runId, seq, compactionId: key };
    default:
      return unknownPartItem("rich-part", displayName, key, data, runId, seq);
  }
}

function insertUnknownPart(
  draft: Draft,
  envelope: TranscriptEnvelope,
  input: {
    key: string;
    source: UnknownPartSource;
    name: string;
    data: unknown;
    runId: string | null;
  },
): void {
  if (getItem(draft, input.key)) return;
  const seq = nextSeqValue(draft, envelope);
  insertItem(
    draft,
    unknownPartItem(
      input.source,
      input.name,
      input.key,
      input.data,
      input.runId,
      seq,
    ),
  );
}

function unknownPartItem(
  source: UnknownPartSource,
  name: string,
  key: string,
  data: unknown,
  runId: string | null,
  seq: number,
): UnknownPartItem {
  return {
    kind: "unknown-part",
    key,
    runId,
    seq,
    partId: key,
    label: `Unsupported: ${name}`,
    source,
    name,
    data,
  };
}

function diffChangeKind(
  oldContent: string | null,
  newContent: string,
  unifiedDiff: string | null,
): DiffChangeKind {
  if (unifiedDiff?.includes("--- /dev/null")) return "created";
  if (unifiedDiff?.includes("+++ /dev/null")) return "deleted";
  if (oldContent === null || oldContent.length === 0) return "created";
  if (newContent.length === 0) return "deleted";
  return "modified";
}

function diffItem(
  key: string,
  data: unknown,
  runId: string | null,
  seq: number,
): DiffItem {
  const oldContent = readString(data, "oldContent");
  const newContent = readString(data, "newContent") ?? "";
  const unifiedDiff =
    readString(data, "unifiedDiff") ?? readString(data, "diff");
  const status = readString(data, "status");
  return {
    kind: "diff",
    key,
    runId,
    seq,
    diffId: key,
    filePath: readString(data, "filePath") ?? "",
    oldContent,
    newContent,
    unifiedDiff,
    changeKind: diffChangeKind(oldContent, newContent, unifiedDiff),
    status: status === "applied" || status === "rejected" ? status : "pending",
  };
}

function planItem(
  key: string,
  data: unknown,
  runId: string | null,
  seq: number,
): PlanItem {
  const rawEntries =
    data && typeof data === "object" ? Reflect.get(data, "entries") : null;
  const entries: PlanEntry[] = Array.isArray(rawEntries)
    ? rawEntries.map((entry) => ({
        id: readString(entry, "id"),
        content: readString(entry, "content") ?? "",
        status: normalizePlanStatus(readString(entry, "status")),
        priority: normalizePlanPriority(readString(entry, "priority")),
      }))
    : [];
  return { kind: "plan", key, runId, seq, planId: key, entries };
}

function normalizePlanStatus(status: string | null): PlanEntry["status"] {
  return status === "in_progress" || status === "completed"
    ? status
    : "pending";
}

function normalizePlanPriority(priority: string | null): PlanEntry["priority"] {
  return priority === "high" || priority === "medium" || priority === "low"
    ? priority
    : null;
}

function terminalItem(
  key: string,
  data: unknown,
  runId: string | null,
  seq: number,
): TerminalItem {
  const rawChunks =
    data && typeof data === "object" ? Reflect.get(data, "chunks") : null;
  const chunks: TerminalChunk[] = Array.isArray(rawChunks)
    ? rawChunks.map((chunk, chunkIndex) => ({
        streamSeq: readNumber(chunk, "streamSeq") ?? chunkIndex,
        stream: normalizeTerminalStream(readString(chunk, "kind")),
        text: readString(chunk, "text") ?? "",
      }))
    : [];
  return {
    kind: "terminal",
    key,
    runId,
    seq,
    terminalId: readString(data, "terminalId") ?? key,
    chunks,
    exitCode: readNumber(data, "exitCode"),
  };
}

function normalizeTerminalStream(kind: string | null): TerminalChunk["stream"] {
  return kind === "stderr" || kind === "interaction" ? kind : "stdout";
}

function imageItem(
  key: string,
  data: unknown,
  runId: string | null,
  seq: number,
): ImageItem {
  return {
    kind: "image",
    key,
    runId,
    seq,
    imageId: key,
    mimeType: readString(data, "mimeType"),
    url: readString(data, "uri") ?? readString(data, "url"),
    data: readString(data, "data"),
  };
}

function attachmentItem(
  key: string,
  data: unknown,
  runId: string | null,
  seq: number,
): AttachmentItem {
  return {
    kind: "attachment",
    key,
    runId,
    seq,
    attachmentId: key,
    name: readString(data, "name") ?? readString(data, "title"),
    mimeType: readString(data, "mimeType"),
    url: readString(data, "uri") ?? readString(data, "url"),
    size: readNumber(data, "size"),
  };
}

function errorItem(
  key: string,
  data: unknown,
  runId: string | null,
  seq: number,
): ErrorItem {
  return {
    kind: "error",
    key,
    runId,
    seq,
    errorId: key,
    message: readString(data, "message") ?? "",
    stack: readString(data, "stack"),
  };
}

function permissionItem(
  key: string,
  data: unknown,
  runId: string | null,
  seq: number,
): PermissionItem {
  const decisionRaw = readString(data, "decision");
  const decision =
    decisionRaw === "approved" || decisionRaw === "denied" ? decisionRaw : null;
  const statusRaw = readString(data, "status");
  const status =
    statusRaw === "approved" || statusRaw === "denied" ? statusRaw : "pending";
  const options: PermissionOption[] = [
    { kind: "approve", name: "Approve", optionId: "approved" },
    { kind: "deny", name: "Deny", optionId: "denied" },
  ];
  return {
    kind: "permission",
    key,
    runId,
    seq,
    permissionRequestId: readString(data, "reviewId") ?? key,
    title: readString(data, "action") ?? "Approval required",
    description: readString(data, "rationale"),
    options,
    decision,
    status,
  };
}

function sourcesItem(
  key: string,
  data: unknown,
  runId: string | null,
  seq: number,
): SourcesItem {
  const rawSources =
    data && typeof data === "object" ? Reflect.get(data, "sources") : null;
  const sources: SourceEntry[] = Array.isArray(rawSources)
    ? rawSources.map((entry) => ({
        url: readString(entry, "url"),
        title: readString(entry, "title"),
      }))
    : [];
  return {
    kind: "sources",
    key,
    runId,
    seq,
    sourcesId: key,
    query: readString(data, "query"),
    sources,
  };
}

function delegationItem(
  key: string,
  data: unknown,
  runId: string | null,
  seq: number,
): DelegationItem {
  const rawActivities =
    data && typeof data === "object" ? Reflect.get(data, "activities") : null;
  const activities: DelegationActivity[] = Array.isArray(rawActivities)
    ? rawActivities.map((entry, activityIndex) => ({
        seq: readNumber(entry, "seq") ?? activityIndex,
        text: readString(entry, "text") ?? "",
        status: readString(entry, "status"),
      }))
    : [];
  const statusRaw = readString(data, "status");
  const status: ToolCallStatus =
    statusRaw === "error"
      ? "error"
      : statusRaw === "success" || statusRaw === "completed"
        ? "success"
        : "running";
  return {
    kind: "delegation",
    key,
    runId,
    seq,
    delegationId: key,
    agentName: readString(data, "agentName"),
    activities,
    status,
  };
}

export function foldAgUiEnvelopes(
  envelopes: readonly TranscriptEnvelope[],
  initial: TranscriptState = createInitialTranscriptState(),
): TranscriptState {
  let state = initial;
  for (const envelope of envelopes) {
    state = applyAgUiEvent(state, envelope);
  }
  return state;
}
