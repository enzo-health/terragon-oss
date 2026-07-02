import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import type { DBMessage } from "../db/db-message";
import { providerRichPartToDbMessages } from "./provider-rich-part-to-db";

export function deriveDBMessagesFromCanonical(
  canonicalEvents: readonly CanonicalEvent[],
): DBMessage[] {
  const messages: DBMessage[] = [];
  for (const event of canonicalEvents) {
    switch (event.type) {
      case "assistant-message":
        messages.push({
          type: "agent",
          parent_tool_use_id: event.parentToolUseId ?? null,
          parts: [{ type: "text", text: event.content }],
        });
        break;
      case "tool-call-start":
        messages.push({
          type: "tool-call",
          id: event.toolCallId,
          name: event.name,
          parameters: event.parameters,
          parent_tool_use_id: event.parentToolUseId ?? null,
        });
        break;
      case "tool-call-result":
        messages.push({
          type: "tool-result",
          id: event.toolCallId,
          is_error: event.isError,
          result: event.result,
          parent_tool_use_id: event.parentToolUseId ?? null,
        });
        break;
      case "provider-rich-part":
        messages.push(...providerRichPartToDbMessages(event));
        break;
      case "run-started":
      case "run-terminal":
      case "tool-call-progress":
      case "reasoning-message":
      case "permission-request":
      case "permission-response":
      case "artifact-reference":
      case "meta":
      case "unknown-provider-event":
        break;
      default: {
        const _exhaustiveCheck: never = event;
        return _exhaustiveCheck;
      }
    }
  }
  return messages;
}
