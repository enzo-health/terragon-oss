import type { InputContent, Message as AgUiMessage } from "@ag-ui/core";
import type {
  DBImagePart,
  DBRichTextPart,
  DBUserMessage,
} from "@terragon/shared";

type AgUiUserMessage = Extract<AgUiMessage, { role: "user" }>;

export type DbUserPartsFromAgUiContentResult =
  | { type: "ok"; parts: DBUserMessage["parts"] }
  | { type: "unsupported"; reason: string };

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
