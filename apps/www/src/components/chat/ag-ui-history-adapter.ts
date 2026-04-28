import type { Message as AgUiMessage } from "@ag-ui/core";
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

type AgUiInputContent = Extract<AgUiMessage, { role: "user" }>["content"];
type AgUiInputPart = Extract<AgUiInputContent, readonly unknown[]>[number];
type AgUiToolCall = NonNullable<
  Extract<AgUiMessage, { role: "assistant" }>["toolCalls"]
>[number];
type ReadonlyJSONValue =
  | string
  | number
  | boolean
  | null
  | readonly ReadonlyJSONValue[]
  | ReadonlyJSONObject;
type ReadonlyJSONObject = { readonly [key: string]: ReadonlyJSONValue };
export type AgUiHistoryLoader = () =>
  | readonly AgUiMessage[]
  | Promise<readonly AgUiMessage[]>;

const HISTORY_CREATED_AT = new Date(0);
const COMPLETE_STATUS = {
  type: "complete",
  reason: "unknown",
} satisfies MessageStatus;

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

function isReadonlyJSONValue(value: unknown): value is ReadonlyJSONValue {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "object":
      if (Array.isArray(value)) {
        return value.every(isReadonlyJSONValue);
      }
      return isReadonlyJSONObject(value);
    default:
      return false;
  }
}

function isReadonlyJSONObject(value: unknown): value is ReadonlyJSONObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isReadonlyJSONValue)
  );
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

function applyToolResult(params: {
  messages: ThreadMessage[];
  message: Extract<AgUiMessage, { role: "tool" }>;
}): boolean {
  const { messages, message } = params;
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const candidate = messages[messageIndex];
    if (!candidate || candidate.role !== "assistant") {
      continue;
    }
    const partIndex = candidate.content.findIndex(
      (part) =>
        part.type === "tool-call" && part.toolCallId === message.toolCallId,
    );
    if (partIndex === -1) {
      continue;
    }
    const nextContent = [...candidate.content];
    const toolPart = nextContent[partIndex];
    if (!toolPart || toolPart.type !== "tool-call") {
      continue;
    }
    nextContent[partIndex] = {
      ...toolPart,
      result: message.content,
      ...(message.error ? { isError: true } : {}),
    };
    messages[messageIndex] = {
      ...candidate,
      content: nextContent,
    };
    return true;
  }
  return false;
}

export function agUiMessagesToThreadMessages(
  agUiMessages: readonly AgUiMessage[],
): ThreadMessage[] {
  const messages: ThreadMessage[] = [];

  for (const message of agUiMessages) {
    switch (message.role) {
      case "user":
        messages.push(userMessage(message));
        break;
      case "system":
        messages.push(systemMessage(message));
        break;
      case "assistant":
        messages.push(assistantMessage(message));
        break;
      case "tool":
        if (!applyToolResult({ messages, message })) {
          messages.push(
            assistantMessage({
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
            }),
          );
          applyToolResult({ messages, message });
        }
        break;
      default:
        break;
    }
  }

  return messages;
}

export function createAgUiHistoryAdapter(
  loadAgUiMessages: AgUiHistoryLoader,
): ThreadHistoryAdapter {
  return {
    load: async () => {
      const agUiMessages = await loadAgUiMessages();
      const messages = agUiMessagesToThreadMessages(agUiMessages);
      return {
        messages: messages.map((message, index) => ({
          parentId: messages[index - 1]?.id ?? null,
          message,
        })),
        headId: messages.at(-1)?.id ?? null,
        unstable_resume: true,
      };
    },
    append: async () => {},
  };
}
