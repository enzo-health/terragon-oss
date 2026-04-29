"use client";

import type { InputContent, Message as AgUiMessage } from "@ag-ui/core";
import type { ThreadMessage } from "@assistant-ui/react";
import { stringifyRuntimeValue } from "./assistant-ui/runtime-stringify";

type AttachmentLike = {
  name?: string | undefined;
  contentType?: string | undefined;
  content?: readonly unknown[] | undefined;
};

type ThreadMessageLike = {
  id: string;
  role: string;
  content: unknown;
  name?: string;
  toolCallId?: string;
  error?: string;
  attachments?: readonly AttachmentLike[];
};

type AgUiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ToolCallPart = {
  type: "tool-call";
  toolCallId?: string;
  toolName?: string;
  argsText?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  unstable_toolMessageId?: string;
};

type AgUiTool = {
  name: string;
  description: string;
  parameters: unknown;
};

type ToolLike = {
  description?: string | undefined;
  parameters?: unknown;
  inputSchema?: unknown;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getString = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

function generateFallbackId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  );
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isObject(part) &&
        part["type"] === "text" &&
        typeof part["text"] === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function parseDataUrl(
  value: string,
): { mimeType: string; data: string } | null {
  const match = value.match(/^data:([^;,]+)(?:;[^;,]+)*;base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1] ?? "", data: match[2] ?? "" };
}

const httpUrlPattern = /^https?:\/\//i;

function toInputContent(
  part: unknown,
  fallbackMimeType: string | undefined,
): InputContent | null {
  if (!isObject(part)) return null;
  const type = getString(part, "type");

  if (type === "text") {
    const text = getString(part, "text");
    if (text === undefined) return null;
    return { type: "text", text };
  }

  if (type === "image") {
    const image = getString(part, "image");
    if (image === undefined) return null;
    const parsed = parseDataUrl(image);
    if (parsed) {
      return {
        type: "image",
        source: {
          type: "data",
          value: parsed.data,
          mimeType: parsed.mimeType,
        },
      };
    }
    return {
      type: "image",
      source: {
        type: "url",
        value: image,
        ...(fallbackMimeType !== undefined
          ? { mimeType: fallbackMimeType }
          : {}),
      },
    };
  }

  if (type === "file") {
    const data = getString(part, "data");
    if (data === undefined) return null;
    const partMimeType = getString(part, "mimeType");
    const filename = getString(part, "filename");
    const mimeType =
      partMimeType || fallbackMimeType || "application/octet-stream";

    if (httpUrlPattern.test(data)) {
      return {
        type: "binary",
        mimeType,
        url: data,
        ...(filename !== undefined ? { filename } : {}),
      };
    }
    const parsed = parseDataUrl(data);
    return {
      type: "binary",
      mimeType: parsed?.mimeType ?? mimeType,
      data: parsed?.data ?? data,
      ...(filename !== undefined ? { filename } : {}),
    };
  }

  return null;
}

function buildUserContent(message: ThreadMessageLike): string | InputContent[] {
  const contentParts = Array.isArray(message.content) ? message.content : [];

  const converted: InputContent[] = [];

  if (typeof message.content === "string" && message.content.length > 0) {
    converted.push({ type: "text", text: message.content });
  }

  for (const part of contentParts) {
    const input = toInputContent(part, undefined);
    if (input) converted.push(input);
  }
  for (const attachment of message.attachments ?? []) {
    if (!isObject(attachment)) continue;
    const attachmentContent = attachment["content"];
    if (!Array.isArray(attachmentContent)) continue;
    const fallbackMime = getString(attachment, "contentType");
    for (const part of attachmentContent) {
      const input = toInputContent(part, fallbackMime);
      if (input) converted.push(input);
    }
  }

  const hasNonText = converted.some((part) => part.type !== "text");
  if (hasNonText) return converted;

  if (converted.length === 0) return extractText(message.content);
  return converted
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

function normalizeToolCall(part: ToolCallPart): {
  id: string;
  call: AgUiToolCall;
} {
  const id = part.toolCallId ?? generateFallbackId();
  const argsText =
    typeof part.argsText === "string"
      ? part.argsText
      : stringifyRuntimeValue(part.args ?? {});

  return {
    id,
    call: {
      id,
      type: "function",
      function: {
        name: part.toolName ?? "tool",
        arguments: argsText,
      },
    },
  };
}

function isToolCallPart(part: unknown): part is ToolCallPart {
  return isObject(part) && part["type"] === "tool-call";
}

function convertAssistantMessage(
  message: ThreadMessageLike,
  converted: AgUiMessage[],
): void {
  const content = extractText(message.content);
  const contentArray = Array.isArray(message.content) ? message.content : [];
  const toolCallParts = contentArray.filter(isToolCallPart);
  const toolCalls = toolCallParts.map((part) => ({
    ...normalizeToolCall(part),
    part,
  }));

  const assistantMessage: AgUiMessage = {
    id: message.id,
    role: "assistant",
    content,
  };
  if (message.name) {
    assistantMessage.name = message.name;
  }
  if (toolCalls.length > 0) {
    assistantMessage.toolCalls = toolCalls.map((entry) => entry.call);
  }
  converted.push(assistantMessage);

  for (const { id: toolCallId, part } of toolCalls) {
    if (part.result === undefined) continue;

    const resultContent =
      typeof part.result === "string"
        ? part.result
        : stringifyRuntimeValue(part.result);

    const toolMessage: AgUiMessage = {
      id: part.unstable_toolMessageId ?? `${toolCallId}:tool`,
      role: "tool",
      content: resultContent,
      toolCallId,
    };
    if (part.isError) {
      toolMessage.error = resultContent;
    }
    converted.push(toolMessage);
  }
}

export function toAgUiMessages(
  messages: readonly ThreadMessage[],
): AgUiMessage[] {
  const converted: AgUiMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      convertAssistantMessage(message, converted);
      continue;
    }

    if (message.role === "user") {
      converted.push({
        id: message.id,
        role: "user",
        content: buildUserContent(message),
      });
      continue;
    }

    converted.push({
      id: message.id,
      role: "system",
      content: extractText(message.content),
    });
  }

  return converted;
}

export function toAgUiTools(
  tools: Record<string, ToolLike> | undefined,
): AgUiTool[] {
  if (!tools) return [];

  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? tool.inputSchema ?? {},
  }));
}
