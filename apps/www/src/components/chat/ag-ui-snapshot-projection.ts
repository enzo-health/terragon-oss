import type { AIAgent } from "@terragon/agent/types";
import type { DBSystemMessage, UIMessage } from "@terragon/shared";
import { getField, safeStringify } from "./ag-ui-reducer-utils";

export function agUiSnapshotMessageToUiMessage(
  value: unknown,
  agent: AIAgent,
): UIMessage | null {
  const id = getField<string>(value, "id");
  const role = getField<string>(value, "role");
  if (!id || !role) {
    return null;
  }
  const text = snapshotContentToText(getField<unknown>(value, "content"));
  switch (role) {
    case "user":
      return {
        id,
        role: "user",
        parts: [{ type: "text", text }],
        model: null,
      };
    case "assistant":
      return {
        id,
        role: "agent",
        agent,
        parts: text ? [{ type: "text", text }] : [],
      };
    case "system": {
      const messageType = sideEffectSystemMessageTypeFromId(id);
      if (!messageType) {
        return null;
      }
      return {
        id,
        role: "system",
        message_type: messageType,
        parts: [{ type: "text", text }],
      };
    }
    default:
      return null;
  }
}

function snapshotContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === undefined || content === null) {
    return "";
  }
  return safeStringify(content);
}

const SIDE_EFFECT_SYSTEM_MESSAGE_TYPES = new Set<
  DBSystemMessage["message_type"]
>(["invalid-token-retry", "compact-result"]);

function sideEffectSystemMessageTypeFromId(
  id: string,
): DBSystemMessage["message_type"] | null {
  const match = /^side-effect-system:(.+)-\d+-[a-f0-9]{12}$/.exec(id);
  const messageType = match?.[1];
  if (
    messageType &&
    SIDE_EFFECT_SYSTEM_MESSAGE_TYPES.has(
      messageType as DBSystemMessage["message_type"],
    )
  ) {
    return messageType as DBSystemMessage["message_type"];
  }
  return null;
}
