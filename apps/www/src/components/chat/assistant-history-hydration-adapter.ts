import { type Message as AgUiMessage } from "@ag-ui/core";
import type {
  CompleteAttachment,
  FileMessagePart,
  ImageMessagePart,
  MessageStatus,
  TextMessagePart,
  ThreadAssistantMessage,
  ThreadAssistantMessagePart,
  ThreadHistoryAdapter,
  ThreadMessage,
  ThreadSystemMessage,
  ThreadUserMessage,
  ThreadUserMessagePart,
  ToolCallMessagePart,
} from "@assistant-ui/react";
import {
  applyCustomPartEvent,
  isReadonlyJSONObject,
  terragonDataPartIdentityKey,
  type ReadonlyJSONObject,
  type TerragonDataPart,
  type TerragonCustomPartEvent,
} from "./ag-ui-custom-parts";

type AgUiInputContent = Extract<AgUiMessage, { role: "user" }>["content"];
type AgUiInputPart = Extract<AgUiInputContent, readonly unknown[]>[number];
type AgUiToolCall = NonNullable<
  Extract<AgUiMessage, { role: "assistant" }>["toolCalls"]
>[number];
type AgUiHistoryItem = AgUiMessage | TerragonCustomPartEvent;
export type AssistantHistoryHydrationLoader = () =>
  | readonly AgUiHistoryItem[]
  | Promise<readonly AgUiHistoryItem[]>;
export type AssistantHistoryHydrationMode = "active-resume" | "idle-finalized";

const HISTORY_CREATED_AT = new Date(0);
const COMPLETE_STATUS = {
  type: "complete",
  reason: "unknown",
} satisfies MessageStatus;
const UNRESOLVED_TOOL_RESULT = "Tool call ended without a result.";

type ToolCallLocation = {
  messageIndex: number;
  partIndex: number;
};

type HydrationIndexes = {
  messageIds: Set<string>;
  assistantMessageIndexById: Map<string, number>;
  toolCallLocationById: Map<string, ToolCallLocation>;
  terragonDataPartKeys: Set<string>;
};

function userMetadata(): ThreadUserMessage["metadata"] {
  return { custom: {} };
}

function systemMetadata(): ThreadSystemMessage["metadata"] {
  return { custom: {} };
}

function assistantMetadata(): ThreadAssistantMessage["metadata"] {
  return {
    unstable_state: null,
    unstable_annotations: [],
    unstable_data: [],
    steps: [],
    custom: {},
  };
}

function textPart(text: string): TextMessagePart {
  return { type: "text", text };
}

function dataUrl(params: { mimeType: string; value: string }): string {
  return `data:${params.mimeType};base64,${params.value}`;
}

function inputPartToThreadPart(
  part: AgUiInputPart,
): ThreadUserMessagePart | null {
  if (typeof part !== "object" || part === null || !("type" in part)) {
    return null;
  }

  if (part.type === "text") {
    return textPart(part.text);
  }

  if (part.type === "image") {
    const source = part.source;
    const image: ImageMessagePart = {
      type: "image",
      image:
        source.type === "data"
          ? dataUrl({ mimeType: source.mimeType, value: source.value })
          : source.value,
    };
    return image;
  }

  if (part.type === "binary") {
    const file: FileMessagePart = {
      type: "file",
      mimeType: part.mimeType,
      data: part.data ?? part.url ?? part.id ?? "",
      ...(part.filename ? { filename: part.filename } : {}),
    };
    return file;
  }

  return null;
}

function userContentParts(content: AgUiInputContent): ThreadUserMessagePart[] {
  if (typeof content === "string") {
    return [textPart(content)];
  }

  const parts = content
    .map(inputPartToThreadPart)
    .filter((part): part is ThreadUserMessagePart => part !== null);

  return parts.length > 0 ? parts : [textPart("")];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasStringProperty(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return typeof value[key] === "string";
}

function isAgUiInputPart(value: unknown): value is AgUiInputPart {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "text") {
    return typeof value.text === "string";
  }

  if (value.type === "image") {
    const source = value.source;
    return (
      isRecord(source) &&
      typeof source.type === "string" &&
      typeof source.value === "string" &&
      (source.type !== "data" || typeof source.mimeType === "string")
    );
  }

  if (value.type === "binary") {
    return (
      typeof value.mimeType === "string" &&
      (typeof value.data === "string" ||
        typeof value.url === "string" ||
        typeof value.id === "string")
    );
  }

  return false;
}

function isAgUiInputContent(value: unknown): value is AgUiInputContent {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.every(isAgUiInputPart))
  );
}

function isAgUiToolCall(value: unknown): value is AgUiToolCall {
  if (!isRecord(value) || value.type !== "function") {
    return false;
  }

  const functionValue = value.function;
  return (
    hasStringProperty(value, "id") &&
    isRecord(functionValue) &&
    hasStringProperty(functionValue, "name") &&
    hasStringProperty(functionValue, "arguments")
  );
}

function isAgUiMessage(value: AgUiHistoryItem): value is AgUiMessage {
  if (!isRecord(value) || !hasStringProperty(value, "id")) {
    return false;
  }

  switch (value.role) {
    case "user":
      return "content" in value && isAgUiInputContent(value.content);
    case "system":
      return hasStringProperty(value, "content");
    case "assistant":
      return (
        (value.content === undefined || typeof value.content === "string") &&
        (value.toolCalls === undefined ||
          (Array.isArray(value.toolCalls) &&
            value.toolCalls.every(isAgUiToolCall)))
      );
    case "tool":
      return (
        hasStringProperty(value, "toolCallId") &&
        hasStringProperty(value, "content") &&
        (value.error === undefined || typeof value.error === "string")
      );
    default:
      return false;
  }
}

function parseToolArgs(argsText: string): ReadonlyJSONObject {
  if (argsText.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(argsText);
    if (isReadonlyJSONObject(parsed)) {
      return parsed;
    }
  } catch {
    return {};
  }
  return {};
}

function toolCallPart(toolCall: AgUiToolCall): ToolCallMessagePart {
  const argsText = toolCall.function.arguments;
  return {
    type: "tool-call",
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    argsText,
    args: parseToolArgs(argsText),
  };
}

function appendUniqueMessage(
  messages: ThreadMessage[],
  indexes: HydrationIndexes,
  message: ThreadMessage,
): void {
  if (indexes.messageIds.has(message.id)) {
    return;
  }
  messages.push(message);
  registerMessage({
    indexes,
    message,
    messageIndex: messages.length - 1,
  });
}

function userMessage(message: Extract<AgUiMessage, { role: "user" }>) {
  return {
    id: message.id,
    role: "user",
    createdAt: HISTORY_CREATED_AT,
    content: userContentParts(message.content),
    attachments: [] satisfies CompleteAttachment[],
    metadata: userMetadata(),
  } satisfies ThreadUserMessage;
}

function systemMessage(message: Extract<AgUiMessage, { role: "system" }>) {
  return {
    id: message.id,
    role: "system",
    createdAt: HISTORY_CREATED_AT,
    content: [textPart(message.content)],
    metadata: systemMetadata(),
  } satisfies ThreadSystemMessage;
}

function assistantMessage(
  message: Extract<AgUiMessage, { role: "assistant" }>,
) {
  const parts: ThreadAssistantMessagePart[] = [];
  const text = message.content ?? "";
  if (text.length > 0) {
    parts.push(textPart(text));
  }
  for (const toolCall of message.toolCalls ?? []) {
    parts.push(toolCallPart(toolCall));
  }

  return {
    id: message.id,
    role: "assistant",
    createdAt: HISTORY_CREATED_AT,
    content: parts,
    status: COMPLETE_STATUS,
    metadata: assistantMetadata(),
  } satisfies ThreadAssistantMessage;
}

function upsertAssistantMessage(params: {
  messages: ThreadMessage[];
  indexes: HydrationIndexes;
  message: Extract<AgUiMessage, { role: "assistant" }>;
}): void {
  const { messages, indexes, message } = params;
  const incoming = assistantMessage(message);
  const existingIndex = indexes.assistantMessageIndexById.get(incoming.id);
  if (existingIndex === undefined) {
    messages.push(incoming);
    registerMessage({
      indexes,
      message: incoming,
      messageIndex: messages.length - 1,
    });
    return;
  }

  const existing = messages[existingIndex];
  if (!existing || existing.role !== "assistant") {
    messages.push(incoming);
    registerMessage({
      indexes,
      message: incoming,
      messageIndex: messages.length - 1,
    });
    return;
  }

  const appendedPartStartIndex = existing.content.length;
  messages[existingIndex] = {
    ...existing,
    content: [...existing.content, ...incoming.content],
    status: incoming.status,
  };
  registerAssistantToolCalls({
    indexes,
    messageIndex: existingIndex,
    content: incoming.content,
    startPartIndex: appendedPartStartIndex,
  });
}

function applyToolResult(params: {
  messages: ThreadMessage[];
  toolCallLocationById: Map<string, ToolCallLocation>;
  message: Extract<AgUiMessage, { role: "tool" }>;
}): boolean {
  const { messages, toolCallLocationById, message } = params;
  const isError = isFailedToolMessage(message);
  const location = toolCallLocationById.get(message.toolCallId);
  if (!location) {
    return false;
  }
  const candidate = messages[location.messageIndex];
  if (!candidate || candidate.role !== "assistant") {
    return false;
  }
  const nextContent = [...candidate.content];
  const toolPart = nextContent[location.partIndex];
  if (!toolPart || toolPart.type !== "tool-call") {
    return false;
  }
  nextContent[location.partIndex] = {
    ...toolPart,
    result: message.content,
    ...(isError ? { isError: true } : {}),
  };
  messages[location.messageIndex] = {
    ...candidate,
    content: nextContent,
  };
  return true;
}

function registerMessage(params: {
  indexes: HydrationIndexes;
  message: ThreadMessage;
  messageIndex: number;
}): void {
  const { indexes, message, messageIndex } = params;
  indexes.messageIds.add(message.id);
  if (message.role !== "assistant") {
    return;
  }
  if (!indexes.assistantMessageIndexById.has(message.id)) {
    indexes.assistantMessageIndexById.set(message.id, messageIndex);
  }
  registerAssistantToolCalls({
    indexes,
    messageIndex,
    content: message.content,
    startPartIndex: 0,
  });
}

function registerTerragonDataPart(
  indexes: HydrationIndexes,
  dataPart: TerragonDataPart,
): void {
  indexes.terragonDataPartKeys.add(terragonDataPartIdentityKey(dataPart));
}

function registerAssistantToolCalls(params: {
  indexes: HydrationIndexes;
  messageIndex: number;
  content: readonly ThreadAssistantMessagePart[];
  startPartIndex: number;
}): void {
  const { indexes, messageIndex, content, startPartIndex } = params;
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index];
    if (!part || part.type !== "tool-call") {
      continue;
    }
    const existing = indexes.toolCallLocationById.get(part.toolCallId);
    if (existing?.messageIndex === messageIndex) {
      continue;
    }
    indexes.toolCallLocationById.set(part.toolCallId, {
      messageIndex,
      partIndex: startPartIndex + index,
    });
  }
}

function isFailedToolMessage(
  message: Extract<AgUiMessage, { role: "tool" }>,
): boolean {
  const isError = Reflect.get(message, "isError");
  const status = Reflect.get(message, "status");
  const error = Reflect.get(message, "error");
  return isError === true || status === "error" || typeof error === "string";
}

function finishUnresolvedToolCalls(messages: ThreadMessage[]): ThreadMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }

    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-call" || part.result !== undefined) {
        return part;
      }
      changed = true;
      return {
        ...part,
        result: UNRESOLVED_TOOL_RESULT,
        isError: true,
      };
    });

    return changed ? { ...message, content } : message;
  });
}

export function hydrateAssistantHistoryMessages(
  agUiMessages: readonly AgUiHistoryItem[],
): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  const indexes: HydrationIndexes = {
    messageIds: new Set<string>(),
    assistantMessageIndexById: new Map<string, number>(),
    toolCallLocationById: new Map<string, ToolCallLocation>(),
    terragonDataPartKeys: new Set<string>(),
  };

  for (const item of agUiMessages) {
    if (!isAgUiMessage(item)) {
      applyCustomPartEvent({
        messages,
        event: item,
        findAssistantMessageIndex: (messageId) =>
          indexes.assistantMessageIndexById.get(messageId),
        onAssistantMessageCreated: (messageId, messageIndex) => {
          if (!indexes.assistantMessageIndexById.has(messageId)) {
            indexes.assistantMessageIndexById.set(messageId, messageIndex);
          }
        },
        hasTerragonDataPart: (dataPart) =>
          indexes.terragonDataPartKeys.has(
            terragonDataPartIdentityKey(dataPart),
          ),
        onTerragonDataPartAppended: (dataPart) =>
          registerTerragonDataPart(indexes, dataPart),
        createAssistantMessage: (messageId) =>
          assistantMessage({
            id: messageId,
            role: "assistant",
            content: "",
          }),
      });
      continue;
    }
    const message = item;
    switch (message.role) {
      case "user": {
        appendUniqueMessage(messages, indexes, userMessage(message));
        break;
      }
      case "system": {
        appendUniqueMessage(messages, indexes, systemMessage(message));
        break;
      }
      case "assistant":
        upsertAssistantMessage({ messages, indexes, message });
        break;
      case "tool":
        if (
          !applyToolResult({
            messages,
            toolCallLocationById: indexes.toolCallLocationById,
            message,
          })
        ) {
          const fallbackAssistant = assistantMessage({
            id: `${message.id}:assistant`,
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: message.toolCallId,
                type: "function",
                function: { name: "tool", arguments: "{}" },
              },
            ],
          });
          messages.push(fallbackAssistant);
          registerMessage({
            indexes,
            message: fallbackAssistant,
            messageIndex: messages.length - 1,
          });
          applyToolResult({
            messages,
            toolCallLocationById: indexes.toolCallLocationById,
            message,
          });
        }
        break;
      default:
        break;
    }
  }

  return messages;
}

export function createAssistantHistoryHydrationAdapter(
  loadAgUiMessages: AssistantHistoryHydrationLoader,
  options: { mode?: AssistantHistoryHydrationMode } = {},
): ThreadHistoryAdapter {
  return {
    load: async () => {
      const agUiMessages = await loadAgUiMessages();
      const importedMessages = hydrateAssistantHistoryMessages(agUiMessages);
      const mode = options.mode ?? "active-resume";
      const messages =
        mode === "idle-finalized"
          ? finishUnresolvedToolCalls(importedMessages)
          : importedMessages;
      return {
        messages: messages.map((message, index) => ({
          parentId: messages[index - 1]?.id ?? null,
          message,
        })),
        headId: messages.at(-1)?.id ?? null,
        unstable_resume: mode === "active-resume",
      };
    },
    append: async () => {},
  };
}
