import type { InputContent, Message as AgUiMessage } from "@ag-ui/core";
import type { ThreadUserMessagePart } from "@assistant-ui/react";
import type {
  DBImagePart,
  DBRichTextPart,
  DBUserMessage,
} from "@terragon/shared";

type AgUiUserMessage = Extract<AgUiMessage, { role: "user" }>;

export type DbUserPartsFromAgUiContentResult =
  | { type: "ok"; parts: DBUserMessage["parts"] }
  | { type: "unsupported"; reason: string };

export function dbUserPartsToAssistantContent(
  parts: DBUserMessage["parts"],
): ThreadUserMessagePart[] {
  const result: ThreadUserMessagePart[] = [];
  for (const part of parts) {
    if (part.type === "rich-text") {
      const text = part.nodes
        .map((node) => {
          if (typeof node === "string") return node;
          if (node.type === "mention") return `@${node.text}`;
          if ("text" in node && typeof node.text === "string") {
            return node.text;
          }
          return "";
        })
        .join("");
      if (text.length > 0) {
        result.push({ type: "text", text });
      }
    } else if (part.type === "text" && part.text.length > 0) {
      result.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      result.push({ type: "image", image: part.image_url });
    }
  }
  return result;
}

export function dbUserMessageHasUnsupportedAssistantContent(
  userMessage: DBUserMessage,
): boolean {
  return userMessage.parts.some(
    (part) => part.type === "pdf" || part.type === "text-file",
  );
}

export function agUiUserContentToDbParts(
  content: AgUiUserMessage["content"],
): DbUserPartsFromAgUiContentResult {
  if (typeof content === "string") {
    return {
      type: "ok",
      parts:
        content.length > 0
          ? [
              {
                type: "rich-text",
                nodes: [{ type: "text", text: content }],
              },
            ]
          : [],
    };
  }

  const parts: DBUserMessage["parts"] = [];
  for (const item of content) {
    const converted = inputContentToDbPart(item);
    if (converted.type === "unsupported") {
      return converted;
    }
    if (converted.part !== null) {
      parts.push(converted.part);
    }
  }
  return { type: "ok", parts };
}

type InputContentToDbPartResult =
  | { type: "ok"; part: DBImagePart | DBRichTextPart | null }
  | { type: "unsupported"; reason: string };

function inputContentToDbPart(
  content: InputContent,
): InputContentToDbPartResult {
  if (content.type === "text") {
    if (content.text.length === 0) {
      return { type: "ok", part: null };
    }
    return {
      type: "ok",
      part: {
        type: "rich-text",
        nodes: [{ type: "text", text: content.text }],
      },
    };
  }

  if (content.type === "image") {
    const source = content.source;
    if (source.type === "url") {
      return {
        type: "ok",
        part: {
          type: "image",
          image_url: source.value,
          mime_type: source.mimeType ?? "image/jpeg",
        },
      };
    }
    if (source.type === "data") {
      return {
        type: "ok",
        part: {
          type: "image",
          image_url: `data:${source.mimeType};base64,${source.value}`,
          mime_type: source.mimeType,
        },
      };
    }
  }

  return {
    type: "unsupported",
    reason: `AG-UI ${content.type} content is not accepted by follow-up command`,
  };
}
