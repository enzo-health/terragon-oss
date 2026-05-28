import type { AIAgent } from "@terragon/agent/types";
import type { UIMessage } from "@terragon/shared";

export type AgUiMessagesState = {
  /** Projected message list, rendered by TerragonThread. */
  messages: UIMessage[];
  /** Position of every projected message by id. */
  messageIndexes: Record<string, number>;
  /** Position of assistant/agent messages by id. */
  assistantMessageIndexes: Record<string, number>;
  /** Position of tool parts by tool call id. */
  toolPartPositions: Record<string, { messageId: string; partsIndex: number }>;
  /**
   * The agent kind to stamp on newly-created assistant messages. Derived
   * from the active thread chat; fixed for the lifetime of the reducer.
   */
  agent: AIAgent;
  /**
   * Accumulated JSON fragments per active tool call. Resolved on
   * `TOOL_CALL_END` and attached to the matching `UIToolPart.parameters`.
   */
  toolArgsBuffers: Record<string, string>;
  /**
   * The messageId of the most recent `TEXT_MESSAGE_START`. Subsequent tool
   * calls that lack an explicit `parentMessageId` attach to this assistant
   * message. Null before the first assistant message is seen.
   */
  activeAssistantMessageId: string | null;
  /**
   * Position of an active reasoning (thinking) part in the
   * `UIAgentMessage.parts` array. Keyed by reasoning messageId
   * (`<parentId>:thinking:<partIndex>`). Allows subsequent CONTENT deltas
   * to find and mutate the right thinking part without adding marker
   * fields to the rendered UIPart shape.
   */
  reasoningPartPositions: Record<
    string,
    { parentMessageId: string; partsIndex: number }
  >;
};

export function createAgUiMessageIndexes(
  messages: UIMessage[],
): Pick<
  AgUiMessagesState,
  "assistantMessageIndexes" | "messageIndexes" | "toolPartPositions"
> {
  const messageIndexes: Record<string, number> = {};
  const assistantMessageIndexes: Record<string, number> = {};
  const toolPartPositions: Record<
    string,
    { messageId: string; partsIndex: number }
  > = {};

  messages.forEach((message, messageIndex) => {
    messageIndexes[message.id] = messageIndex;
    if (message.role !== "agent") {
      return;
    }
    assistantMessageIndexes[message.id] = messageIndex;
    message.parts.forEach((part, partsIndex) => {
      if (part.type === "tool") {
        toolPartPositions[part.id] = {
          messageId: message.id,
          partsIndex,
        };
      }
    });
  });

  return {
    messageIndexes,
    assistantMessageIndexes,
    toolPartPositions,
  };
}

export function getField<T>(value: unknown, key: string): T | undefined {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, T>)[key];
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
