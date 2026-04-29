import {
  EventType,
  type BaseEvent,
  type CustomEvent,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
  type ReasoningMessageStartEvent,
  type ReasoningMessageContentEvent,
  type ReasoningMessageEndEvent,
  type ToolCallChunkEvent,
} from "@ag-ui/core";

import type {
  AssistantMessageEvent,
  ArtifactReferenceEvent,
  CanonicalEvent,
  MetaEvent as CanonicalMetaEvent,
  OperationalRunStartedEvent,
  OperationalRunTerminalEvent,
  PermissionRequestEvent,
  PermissionResponseEvent,
  ReasoningMessageEvent,
  ToolCallResultEvent as CanonicalToolCallResultEvent,
  ToolCallProgressEvent as CanonicalToolCallProgressEvent,
  ToolCallStartEvent as CanonicalToolCallStartEvent,
} from "./canonical-events";

/**
 * Pure mapping functions from Terragon's canonical events / daemon deltas /
 * meta events to the AG-UI protocol (@ag-ui/core BaseEvent union).
 *
 * No I/O. No side effects. Every function is unit-testable in isolation.
 */

// ---------------------------------------------------------------------------
// Canonical event → AG-UI BaseEvent[]
// ---------------------------------------------------------------------------

/** Map one canonical event to the AG-UI event(s) it represents. */
export function mapCanonicalEventToAgui(event: CanonicalEvent): BaseEvent[] {
  const timestamp = Date.parse(event.timestamp);

  switch (event.type) {
    case "run-started":
      return [mapRunStarted(event, timestamp)];
    case "run-terminal":
      return [mapRunTerminal(event, timestamp)];
    case "assistant-message":
      return mapAssistantMessage(event, timestamp);
    case "tool-call-start":
      return mapToolCallStart(event, timestamp);
    case "tool-call-progress":
      return [mapToolCallProgress(event, timestamp)];
    case "tool-call-result":
      return [mapToolCallResult(event, timestamp)];
    case "reasoning-message":
      return mapReasoningMessage(event, timestamp);
    case "permission-request":
      return mapPermissionRequest(event, timestamp);
    case "permission-response":
      return [mapPermissionResponse(event, timestamp)];
    case "artifact-reference":
      return [mapArtifactReference(event, timestamp)];
    case "meta":
      return [mapCanonicalMeta(event, timestamp)];
    case "unknown-provider-event":
      return [];
    default: {
      const _exhaustiveCheck: never = event;
      return _exhaustiveCheck;
    }
  }
}

function mapRunStarted(
  event: OperationalRunStartedEvent,
  timestamp: number,
): RunStartedEvent {
  return {
    type: EventType.RUN_STARTED,
    timestamp,
    threadId: event.threadId,
    runId: event.runId,
  };
}

function mapRunTerminal(
  event: OperationalRunTerminalEvent,
  timestamp: number,
): RunFinishedEvent | RunErrorEvent {
  if (event.status === "completed") {
    return mapRunFinishedToAgui(event.threadId, event.runId, false, timestamp);
  }
  if (event.status === "stopped") {
    return mapRunFinishedToAgui(event.threadId, event.runId, true, timestamp);
  }
  return mapRunErrorToAgui(
    event.errorMessage ?? "Run failed",
    event.errorCode ?? undefined,
    timestamp,
  );
}

function mapAssistantMessage(
  event: AssistantMessageEvent,
  timestamp: number,
): BaseEvent[] {
  const content = typeof event.content === "string" ? event.content : "";

  const start: TextMessageStartEvent = {
    type: EventType.TEXT_MESSAGE_START,
    timestamp,
    messageId: event.messageId,
    role: "assistant",
  };

  const events: BaseEvent[] = [start];

  if (content.length > 0) {
    const contentEvent: TextMessageContentEvent = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      timestamp,
      messageId: event.messageId,
      delta: content,
    };
    events.push(contentEvent);
  }

  const end: TextMessageEndEvent = {
    type: EventType.TEXT_MESSAGE_END,
    timestamp,
    messageId: event.messageId,
  };
  events.push(end);

  return events;
}

function mapToolCallStart(
  event: CanonicalToolCallStartEvent,
  timestamp: number,
): BaseEvent[] {
  const start: ToolCallStartEvent = {
    type: EventType.TOOL_CALL_START,
    timestamp,
    toolCallId: event.toolCallId,
    toolCallName: event.name,
    ...(event.parentToolUseId
      ? { parentMessageId: event.parentToolUseId }
      : {}),
  };

  // Serialize args as a single ARGS chunk. Daemons that support progressive
  // arg streaming can emit multiple ToolCallArgsEvents between START and END.
  const argsJson = JSON.stringify(event.parameters ?? {});
  const args: ToolCallArgsEvent = {
    type: EventType.TOOL_CALL_ARGS,
    timestamp,
    toolCallId: event.toolCallId,
    delta: argsJson,
  };

  const end: ToolCallEndEvent = {
    type: EventType.TOOL_CALL_END,
    timestamp,
    toolCallId: event.toolCallId,
  };

  return [start, args, end];
}

function mapToolCallResult(
  event: CanonicalToolCallResultEvent,
  timestamp: number,
): ToolCallResultEvent {
  const result: ToolCallResultEvent = {
    type: EventType.TOOL_CALL_RESULT,
    timestamp,
    messageId: event.toolCallId,
    toolCallId: event.toolCallId,
    content: event.result,
  };

  if (event.isError) {
    return { ...result, role: "tool" };
  }

  return result;
}

function mapToolCallProgress(
  event: CanonicalToolCallProgressEvent,
  timestamp: number,
): ToolCallChunkEvent {
  return {
    type: EventType.TOOL_CALL_CHUNK,
    timestamp,
    toolCallId: event.toolCallId,
    delta: event.delta,
    ...(event.progressKind ? { progressKind: event.progressKind } : {}),
  };
}

function mapReasoningMessage(
  event: ReasoningMessageEvent,
  timestamp: number,
): BaseEvent[] {
  const start: ReasoningMessageStartEvent = {
    type: EventType.REASONING_MESSAGE_START,
    timestamp,
    messageId: event.messageId,
    role: "reasoning",
  };

  const events: BaseEvent[] = [start];

  if (event.content.length > 0) {
    const content: ReasoningMessageContentEvent = {
      type: EventType.REASONING_MESSAGE_CONTENT,
      timestamp,
      messageId: event.messageId,
      delta: event.content,
    };
    events.push(content);
  }

  const end: ReasoningMessageEndEvent = {
    type: EventType.REASONING_MESSAGE_END,
    timestamp,
    messageId: event.messageId,
  };
  events.push(end);

  return events;
}

function mapPermissionRequest(
  event: PermissionRequestEvent,
  timestamp: number,
): BaseEvent[] {
  const toolCallId = event.permissionRequestId;
  const start: ToolCallStartEvent = {
    type: EventType.TOOL_CALL_START,
    timestamp,
    toolCallId,
    toolCallName: "PermissionRequest",
  };
  const args: ToolCallArgsEvent = {
    type: EventType.TOOL_CALL_ARGS,
    timestamp,
    toolCallId,
    delta: JSON.stringify({
      tool_name: event.title,
      description: event.description ?? event.title,
      options: event.options.map((option) => ({
        kind: option,
        name: option === "approve" ? "Approve" : "Deny",
        optionId: option === "approve" ? "approved" : "denied",
      })),
    }),
  };
  const end: ToolCallEndEvent = {
    type: EventType.TOOL_CALL_END,
    timestamp,
    toolCallId,
  };
  return [start, args, end];
}

function mapPermissionResponse(
  event: PermissionResponseEvent,
  timestamp: number,
): ToolCallResultEvent {
  return {
    type: EventType.TOOL_CALL_RESULT,
    timestamp,
    messageId: event.permissionRequestId,
    toolCallId: event.permissionRequestId,
    content:
      event.response === "approved"
        ? "Permission granted"
        : "Permission denied",
  };
}

function mapArtifactReference(
  event: ArtifactReferenceEvent,
  timestamp: number,
): CustomEvent {
  return {
    type: EventType.CUSTOM,
    timestamp,
    name: "artifact-reference",
    value: {
      artifactId: event.artifactId,
      artifactType: event.artifactType,
      title: event.title,
      uri: event.uri ?? null,
      status: event.status,
    },
  };
}

function mapCanonicalMeta(
  event: CanonicalMetaEvent,
  timestamp: number,
): CustomEvent {
  return {
    type: EventType.CUSTOM,
    timestamp,
    name: event.name,
    value: {
      ...event.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Daemon delta → AG-UI content event
// ---------------------------------------------------------------------------

export type DaemonDeltaInput = {
  messageId: string;
  partIndex: number;
  deltaSeq: number;
  kind?: "text" | "thinking";
  text: string;
};

export function mapDaemonDeltaToAgui(
  delta: DaemonDeltaInput,
  timestamp = Date.now(),
): BaseEvent {
  if (delta.kind === "thinking") {
    const event: ReasoningMessageContentEvent = {
      type: EventType.REASONING_MESSAGE_CONTENT,
      timestamp,
      messageId: delta.messageId,
      delta: delta.text,
    };
    return event;
  }
  return {
    type: EventType.TEXT_MESSAGE_CONTENT,
    timestamp,
    messageId: delta.messageId,
    delta: delta.text,
  };
}

// ---------------------------------------------------------------------------
// Meta event → AG-UI CUSTOM event (fire-and-forget, not persisted)
// ---------------------------------------------------------------------------

export type MetaEventInput = { kind: string; [key: string]: unknown };

export function mapMetaEventToAgui(
  meta: MetaEventInput,
  timestamp = Date.now(),
): CustomEvent {
  return {
    type: EventType.CUSTOM,
    timestamp,
    name: meta.kind,
    value: meta,
  };
}

// ---------------------------------------------------------------------------
// Run terminal → RUN_FINISHED | RUN_ERROR
// ---------------------------------------------------------------------------

export function mapRunFinishedToAgui(
  threadId: string,
  runId: string,
  stopped = false,
  timestamp = Date.now(),
): RunFinishedEvent {
  return {
    type: EventType.RUN_FINISHED,
    timestamp,
    threadId,
    runId,
    ...(stopped ? { result: { stopped: true } } : {}),
  };
}

export function mapRunErrorToAgui(
  message: string,
  code: string | undefined = undefined,
  timestamp = Date.now(),
): RunErrorEvent {
  return {
    type: EventType.RUN_ERROR,
    timestamp,
    message,
    ...(code ? { code } : {}),
  };
}

// ---------------------------------------------------------------------------
// DBAgentMessage rich parts → AG-UI events
// ---------------------------------------------------------------------------

/**
 * Structural type for a single `DBAgentMessage.parts[i]` entry.
 *
 * We deliberately keep this loose (structural, not nominal): the `@terragon/
 * shared` DB-message union pulls in `AIModel` which is exported from this same
 * package, so an `import type` on `DBAgentMessagePart` would reintroduce the
 * `shared` → `agent` workspace dep as a cycle. Instead we narrow by `type` at
 * runtime and let TypeScript infer enough to access the shape's fields where
 * needed (currently only `thinking.thinking`).
 *
 * Callers in `apps/www` pass real `DBAgentMessagePart` values; the structural
 * contract is enforced at those call sites by `DBAgentMessagePart` itself.
 */
export type DBAgentMessagePartLike = { type: string } & Record<string, unknown>;

const DIFF_TOOL_RESULT_TYPE = "terragon.diff";

type DiffPartLike = DBAgentMessagePartLike & {
  type: "diff";
  filePath: string;
  oldContent?: string;
  newContent: string;
  unifiedDiff?: string;
  status: "pending" | "applied" | "rejected";
};

type DiffToolResultPayload = {
  type: typeof DIFF_TOOL_RESULT_TYPE;
  part: DiffPartLike;
};

/**
 * Part-types that are already expressed via canonical events (assistant-message
 * text, tool-call-start/result) and therefore must NOT be re-emitted here. Kept
 * as a typed literal so the compiler catches drift if we ever rename one.
 */
const SKIPPED_AGENT_PART_TYPES = new Set<string>([
  "text",
  "tool-use",
  "tool-result",
]);

const DATA_PART_EVENT_NAME = "terragon.data-part";

/**
 * Map a `DBAgentMessage.parts` array to the AG-UI events that represent the
 * non-text, non-tool-call parts. These exist in addition to the canonical-
 * events pipeline:
 *   - `assistant-message` canonical events cover `text` parts.
 *   - `tool-call-start` / `tool-call-result` canonical events cover `tool-use`
 *     and `tool-result` parts.
 *   - Tool-created `diff` parts are synthesized as standard `FileChange`
 *     TOOL_CALL_* events so they render through assistant-ui's Tool UI.
 *   - Everything else (thinking, terminal, image, audio, plan, ...) is
 *     NOT represented in canonical events today, so it needs first-class
 *     AG-UI events or the frontend can't reconstruct the full UI state.
 *
 * Thinking parts expand to REASONING_MESSAGE_START + CONTENT + END. Standalone
 * visual variants expand to a single CUSTOM data-part event whose `value`
 * carries `{ messageId, partIndex, name, data }`, matching assistant-ui's
 * DataMessagePart shape at the frontend boundary.
 *
 * The returned events are NOT timestamped per-event; callers pick a single
 * timestamp for the whole message (matching the existing mapper convention).
 */
export function dbAgentMessagePartsToAgUi(
  messageId: string,
  parts: readonly DBAgentMessagePartLike[],
  timestamp = Date.now(),
): BaseEvent[] {
  const events: BaseEvent[] = [];
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex]!;
    if (SKIPPED_AGENT_PART_TYPES.has(part.type)) continue;

    if (part.type === "thinking") {
      // Synthesize a deterministic per-thinking messageId so two thinking
      // parts in the same DBAgentMessage never collide on dedupe at the
      // AG-UI layer. The `:thinking:<idx>` suffix is load-bearing for the
      // frontend reducer — it groups a START/CONTENT/END triple.
      const thinkingMessageId = `${messageId}:thinking:${partIndex}`;
      const text =
        typeof part.thinking === "string"
          ? part.thinking
          : // Defensive: tolerate unexpected shapes rather than throw.
            "";
      const start: ReasoningMessageStartEvent = {
        type: EventType.REASONING_MESSAGE_START,
        timestamp,
        messageId: thinkingMessageId,
        role: "reasoning",
      };
      events.push(start);
      if (text.length > 0) {
        const content: ReasoningMessageContentEvent = {
          type: EventType.REASONING_MESSAGE_CONTENT,
          timestamp,
          messageId: thinkingMessageId,
          delta: text,
        };
        events.push(content);
      }
      const end: ReasoningMessageEndEvent = {
        type: EventType.REASONING_MESSAGE_END,
        timestamp,
        messageId: thinkingMessageId,
      };
      events.push(end);
      continue;
    }

    if (isDiffPart(part)) {
      events.push(
        ...mapDiffPartToToolEvents(messageId, partIndex, part, timestamp),
      );
      continue;
    }

    const custom: CustomEvent = {
      type: EventType.CUSTOM,
      timestamp,
      name: DATA_PART_EVENT_NAME,
      value: {
        messageId,
        partIndex,
        name: `terragon.${part.type}`,
        data: part,
      },
    };
    events.push(custom);
  }
  return events;
}

function isDiffPart(part: DBAgentMessagePartLike): part is DiffPartLike {
  return (
    part.type === "diff" &&
    typeof part.filePath === "string" &&
    typeof part.newContent === "string" &&
    (part.oldContent === undefined || typeof part.oldContent === "string") &&
    (part.unifiedDiff === undefined || typeof part.unifiedDiff === "string") &&
    (part.status === "pending" ||
      part.status === "applied" ||
      part.status === "rejected")
  );
}

function mapDiffPartToToolEvents(
  messageId: string,
  partIndex: number,
  part: DiffPartLike,
  timestamp: number,
): BaseEvent[] {
  const toolCallId = `${messageId}:diff:${partIndex}`;
  const args = {
    files: [{ path: part.filePath, action: diffAction(part) }],
  };
  const resultPayload: DiffToolResultPayload = {
    type: DIFF_TOOL_RESULT_TYPE,
    part,
  };

  const start: ToolCallStartEvent = {
    type: EventType.TOOL_CALL_START,
    timestamp,
    toolCallId,
    toolCallName: "FileChange",
    parentMessageId: messageId,
  };
  const argsEvent: ToolCallArgsEvent = {
    type: EventType.TOOL_CALL_ARGS,
    timestamp,
    toolCallId,
    delta: JSON.stringify(args),
  };
  const end: ToolCallEndEvent = {
    type: EventType.TOOL_CALL_END,
    timestamp,
    toolCallId,
  };
  const result: ToolCallResultEvent = {
    type: EventType.TOOL_CALL_RESULT,
    timestamp,
    messageId: toolCallId,
    toolCallId,
    content: JSON.stringify(resultPayload),
  };

  return [start, argsEvent, end, result];
}

function diffAction(part: DiffPartLike): "created" | "deleted" | "modified" {
  if (part.unifiedDiff?.includes("--- /dev/null")) return "created";
  if (part.unifiedDiff?.includes("+++ /dev/null")) return "deleted";
  if (part.oldContent === undefined || part.oldContent.length === 0) {
    return "created";
  }
  if (part.newContent.length === 0) return "deleted";
  return "modified";
}

// ---------------------------------------------------------------------------
// Convenience: AG-UI event → JSON line for SSE `data:` frames
// ---------------------------------------------------------------------------

export function serializeAgUiEvent(event: BaseEvent): string {
  return JSON.stringify(event);
}
