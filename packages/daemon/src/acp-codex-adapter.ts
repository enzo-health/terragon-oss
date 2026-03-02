import { ClaudeMessage } from "./shared";
import { CodexParserState, CodexItemEvent, parseCodexItem } from "./codex";
import { IDaemonRuntime } from "./runtime";

/**
 * Known Codex ThreadEvent top-level types.
 * Used to detect whether an ACP sessionUpdate content payload
 * is actually a raw Codex event that should be routed through
 * the structured parseCodexItem pipeline.
 */
const CODEX_ITEM_EVENT_TYPES = new Set([
  "item.started",
  "item.updated",
  "item.completed",
]);

const CODEX_TOP_LEVEL_EVENT_TYPES = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "error",
  ...CODEX_ITEM_EVENT_TYPES,
]);

/**
 * Detect whether a value looks like a Codex ThreadEvent.
 * Codex events always have a `type` string field from a known set.
 * Item events additionally have an `item` object with `id` and `type`.
 */
function isCodexEvent(
  value: unknown,
): value is { type: string; [key: string]: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string") {
    return false;
  }
  return CODEX_TOP_LEVEL_EVENT_TYPES.has(obj.type);
}

/**
 * Try to extract a Codex event from an ACP sessionUpdate content field.
 * The content may be:
 *   - A raw object that IS a Codex event (sandbox-agent passes through)
 *   - A JSON string containing a Codex event
 *   - An array with a single element that is a Codex event
 *   - Something else entirely (text, etc.) → return null
 */
function extractCodexEventFromContent(
  content: unknown,
): Record<string, unknown> | null {
  // Direct object
  if (isCodexEvent(content)) {
    return content as Record<string, unknown>;
  }

  // JSON string
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      if (isCodexEvent(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON — regular text content
    }
    return null;
  }

  // Array with single Codex event element
  if (Array.isArray(content) && content.length === 1) {
    const first = content[0];
    if (isCodexEvent(first)) {
      return first as Record<string, unknown>;
    }
    // Check if the single element has a nested Codex event (e.g., {type: "text", text: "{...}"})
    if (
      first &&
      typeof first === "object" &&
      typeof (first as Record<string, unknown>).text === "string"
    ) {
      try {
        const parsed = JSON.parse(
          (first as Record<string, unknown>).text as string,
        );
        if (isCodexEvent(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Not JSON
      }
    }
  }

  return null;
}

/**
 * Handle Codex-specific top-level events that aren't item events.
 * These include thread.started, turn.started/completed/failed, and top-level error.
 */
function handleCodexTopLevelEvent(
  event: Record<string, unknown>,
  sessionId: string,
  state: CodexParserState,
  runtime: IDaemonRuntime,
): ClaudeMessage[] | null {
  const eventType = event.type as string;

  switch (eventType) {
    case "thread.started": {
      state.activeTaskToolUseIds = [];
      return [
        {
          type: "system",
          subtype: "init",
          session_id: (event.thread_id as string) || sessionId,
          tools: [],
          mcp_servers: [],
        },
      ];
    }
    case "turn.started":
    case "turn.failed":
      return [];
    case "turn.completed": {
      runtime.logger.debug("Codex ACP token usage", {
        usage: event.usage,
      });
      return [];
    }
    case "error": {
      const message =
        (typeof event.message === "string" ? event.message : null) ||
        "Codex reported an error.";
      state.activeTaskToolUseIds = [];
      return [
        {
          type: "result",
          subtype: "error_during_execution",
          session_id: sessionId,
          error: message,
          is_error: true,
          num_turns: 0,
          duration_ms: 0,
        },
      ];
    }
    default:
      return null;
  }
}

/**
 * Attempt to parse an ACP SSE payload as a Codex-native event.
 *
 * Returns ClaudeMessage[] if the payload contains a recognized Codex event,
 * or null to signal the caller should fall through to the generic ACP adapter.
 *
 * The detection works by examining the `update.content` of a `session/update`
 * envelope for Codex ThreadEvent structure (type field matching known event types).
 */
export function tryParseAcpAsCodexEvent(
  payload: string,
  sessionId: string,
  state: CodexParserState,
  runtime: IDaemonRuntime,
): ClaudeMessage[] | null {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(payload);
  } catch {
    return null;
  }

  if (!envelope || typeof envelope !== "object") {
    return null;
  }

  // Only intercept session/update method
  if (envelope.method !== "session/update") {
    return null;
  }

  const params = envelope.params as Record<string, unknown> | undefined;
  if (!params) {
    return null;
  }

  const update = params.update as Record<string, unknown> | undefined;
  if (!update) {
    return null;
  }

  const content = update.content;
  const codexEvent = extractCodexEventFromContent(content);
  if (!codexEvent) {
    return null; // Not a Codex event — fall through to generic ACP
  }

  const eventType = codexEvent.type as string;

  // Handle item events through the shared parseCodexItem pipeline
  if (CODEX_ITEM_EVENT_TYPES.has(eventType)) {
    return parseCodexItem({
      codexMsg: codexEvent as unknown as CodexItemEvent,
      runtime,
      state,
    });
  }

  // Handle other Codex top-level events
  const result = handleCodexTopLevelEvent(
    codexEvent,
    sessionId,
    state,
    runtime,
  );
  if (result !== null) {
    return result;
  }

  // Unknown Codex event type — log and fall through
  runtime.logger.warn("Unknown Codex event type in ACP payload", {
    type: eventType,
  });
  return null;
}
