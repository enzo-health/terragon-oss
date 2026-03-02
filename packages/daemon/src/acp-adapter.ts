import { ClaudeMessage } from "./shared";

type JsonObject = Record<string, unknown>;

type JsonRpcEnvelope = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function toTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        const itemObject = asObject(item);
        if (!itemObject) {
          return "";
        }
        const text = itemObject.text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  const contentObject = asObject(content);
  if (!contentObject) {
    return "";
  }
  const text = contentObject.text;
  return typeof text === "string" ? text : "";
}

function getSessionId(params: JsonObject, fallbackSessionId: string): string {
  const sessionId = params.sessionId;
  if (typeof sessionId === "string" && sessionId.length > 0) {
    return sessionId;
  }
  return fallbackSessionId;
}

function parseSessionUpdate(
  params: JsonObject,
  fallbackSessionId: string,
): ClaudeMessage[] {
  const update = asObject(params.update);
  if (!update) {
    return [];
  }
  const sessionId = getSessionId(params, fallbackSessionId);
  const sessionUpdate =
    typeof update.sessionUpdate === "string"
      ? update.sessionUpdate
      : "agent_message_chunk";
  const contentText = toTextContent(update.content);

  if (
    sessionUpdate === "agent_message_chunk" ||
    sessionUpdate === "agent_message" ||
    sessionUpdate === "agent_thought_chunk" ||
    sessionUpdate === "agent_reasoning_chunk"
  ) {
    if (!contentText) {
      return [];
    }
    return [
      {
        type: "assistant",
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role: "assistant",
          content: [{ type: "text", text: contentText }],
        },
      },
    ];
  }

  if (sessionUpdate === "error" || sessionUpdate === "agent_error") {
    const errorMessage =
      contentText ||
      (typeof update.message === "string" ? update.message : "acp_error");
    return [
      {
        type: "custom-error",
        session_id: null,
        duration_ms: 0,
        error_info: errorMessage,
      },
    ];
  }

  // Fallback: surface unknown sessionUpdate types as assistant text if content exists
  if (contentText) {
    return [
      {
        type: "assistant",
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role: "assistant",
          content: [{ type: "text", text: contentText }],
        },
      },
    ];
  }

  return [];
}

function parseEnvelopeError(envelope: JsonObject): ClaudeMessage[] {
  const error = asObject(envelope.error);
  if (!error) {
    return [];
  }
  const message =
    typeof error.message === "string" ? error.message : "acp_error";
  return [
    {
      type: "custom-error",
      session_id: null,
      duration_ms: 0,
      error_info: message,
    },
  ];
}

/**
 * Coalesce consecutive top-level assistant text-only messages into a single message.
 * ACP transports stream token-by-token, producing many tiny ClaudeMessages. This
 * merges them before sending to the server to reduce DB bloat and improve rendering.
 *
 * Only merges when:
 * - Both messages are type "assistant" with parent_tool_use_id === null
 * - Both messages contain exclusively text content blocks (no tool_use)
 * - Both share the same session_id
 */
export function coalesceAssistantTextMessages(
  messages: ClaudeMessage[],
): ClaudeMessage[] {
  if (messages.length <= 1) {
    return messages;
  }

  const result: ClaudeMessage[] = [];
  for (const msg of messages) {
    const prev = result[result.length - 1];
    if (
      prev &&
      prev.type === "assistant" &&
      msg.type === "assistant" &&
      prev.parent_tool_use_id === null &&
      msg.parent_tool_use_id === null &&
      prev.session_id === msg.session_id
    ) {
      const prevContent = prev.message.content;
      const currContent = msg.message.content;
      if (
        Array.isArray(prevContent) &&
        Array.isArray(currContent) &&
        prevContent.every((c) => c.type === "text") &&
        currContent.every((c) => c.type === "text")
      ) {
        // Merge: append all current text to the last text block of prev
        const prevLastText = prevContent[prevContent.length - 1];
        if (prevLastText && prevLastText.type === "text") {
          const mergedText = currContent
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("");
          prevLastText.text += mergedText;
          continue;
        }
      }
    }
    result.push(msg);
  }
  return result;
}

export function parseAcpLineToClaudeMessages(
  line: string,
  fallbackSessionId: string,
): ClaudeMessage[] {
  let parsed: JsonRpcEnvelope | null = null;
  try {
    parsed = JSON.parse(line) as JsonRpcEnvelope;
  } catch {
    return [];
  }
  const envelope = asObject(parsed);
  if (!envelope) {
    return [];
  }
  const method = typeof envelope.method === "string" ? envelope.method : null;
  if (method === "session/update") {
    const params = asObject(envelope.params);
    if (!params) {
      return [];
    }
    return parseSessionUpdate(params, fallbackSessionId);
  }
  return parseEnvelopeError(envelope);
}
