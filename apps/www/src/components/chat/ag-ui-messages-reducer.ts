/**
 * Pure reducer that folds an AG-UI `BaseEvent` stream into `UIMessage[]`.
 *
 * This is the single source of truth for Task 6B — the frontend aggregator
 * that replaces the legacy `DBMessage + delta-patch` pipeline. It consumes
 * the events defined by the AG-UI mapper (`packages/agent/src/ag-ui-
 * mapper.ts`) and produces the same `UIMessage[]` shape the renderer
 * already knows how to display.
 *
 * The reducer is deliberately free of React imports so it is unit-testable
 * without mounting components.
 *
 * # Event contract (subset of AG-UI protocol we honour)
 *
 * - `TEXT_MESSAGE_START { messageId }`            → start/locate assistant msg
 * - `TEXT_MESSAGE_CONTENT { messageId, delta }`   → append text part on msg
 * - `TEXT_MESSAGE_END`                            → no-op
 * - `REASONING_MESSAGE_START { messageId }`       → `<parentId>:thinking:<N>`
 * - `REASONING_MESSAGE_CONTENT { messageId, delta }`
 * - `REASONING_MESSAGE_END { messageId }`
 * - `TOOL_CALL_START { toolCallId, toolCallName }`→ pending tool part
 * - `TOOL_CALL_ARGS { toolCallId, delta }`        → accumulate JSON chunk
 * - `TOOL_CALL_END { toolCallId }`                → parse accumulated args
 * - `TOOL_CALL_RESULT { toolCallId, content }`    → completed/error
 * - `CUSTOM { name: "terragon.data-part", value: { messageId, partIndex, name, data } }`
 * - `MESSAGES_SNAPSHOT { messages }`              → append daemon-owned snapshot messages
 *
 * RUN_FINISHED / RUN_ERROR close any still-pending tool calls so terminal
 * transcripts do not render indefinite in-progress tool rows.
 *
 * # Ordering tolerance
 *
 * The backend currently emits rich-part CUSTOM events in the same batch as
 * the `TEXT_MESSAGE_START` for the same messageId. On SSE replay after
 * reconnect, we may see CUSTOM events for historical messages without a
 * preceding `TEXT_MESSAGE_START`. The reducer handles this by lazily
 * creating an empty assistant message on first reference to an unknown
 * messageId.
 *
 * Tool calls without an explicit `parentMessageId` attach to the most
 * recently-started assistant message. If none exists, a synthetic message
 * is created using the toolCallId as its id (matching the behaviour of
 * the legacy `toUIMessages` pipeline where orphaned tool calls still
 * render).
 */

import { type BaseEvent, EventType } from "@ag-ui/core";
import type { AIAgent } from "@terragon/agent/types";
import type {
  DBSystemMessage,
  UIAgentMessage,
  UIMessage,
  UIPart,
} from "@terragon/shared";
import { terragonDataPartFromCustomEvent } from "./ag-ui-custom-parts";
import {
  MAX_PROGRESS_CHUNKS,
  type ToolProgressChunk,
} from "./tool-progress-chunks";
import type { UIPartExtended } from "./ui-parts-extended";

export type AgUiMessagesState = {
  /** Projected message list, rendered by TerragonThread. */
  messages: UIMessage[];
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

const REASONING_MARKER = ":thinking:";
type ToolStatus = "started" | "in_progress" | "completed" | "failed";
type ToolPartWithProgress = UIPart & {
  type: "tool";
  id: string;
  progressChunks?: ToolProgressChunk[];
  progressHiddenCount?: number;
  toolStatus?: ToolStatus;
};

export function createInitialAgUiMessagesState(
  agent: AIAgent,
  initialMessages: UIMessage[],
): AgUiMessagesState {
  return {
    messages: initialMessages.slice(),
    agent,
    toolArgsBuffers: {},
    activeAssistantMessageId: null,
    reasoningPartPositions: {},
  };
}

/**
 * Fold a single AG-UI `BaseEvent` into the current state. Pure — returns
 * a new state object when it changes, or the same reference when the
 * event is a no-op.
 */
export function agUiMessagesReducer(
  state: AgUiMessagesState,
  event: BaseEvent,
): AgUiMessagesState {
  const eventType = event.type;

  switch (eventType) {
    case EventType.TEXT_MESSAGE_START: {
      const messageId = getField<string>(event, "messageId");
      if (!messageId) return state;
      const { messages, changed } = ensureAssistantMessage(
        state.messages,
        messageId,
        state.agent,
      );
      const nextActive = messageId;
      if (!changed && state.activeAssistantMessageId === nextActive) {
        return state;
      }
      return {
        ...state,
        messages: changed ? messages : state.messages,
        activeAssistantMessageId: nextActive,
      };
    }

    case EventType.TEXT_MESSAGE_CONTENT: {
      const messageId = getField<string>(event, "messageId");
      const delta = getField<string>(event, "delta");
      if (!messageId || !delta) return state;
      return applyTextDelta(state, messageId, delta);
    }

    case EventType.TEXT_MESSAGE_END: {
      return state;
    }

    case EventType.REASONING_MESSAGE_START: {
      const reasoningId = getField<string>(event, "messageId");
      if (!reasoningId) return state;
      const parsed = parseReasoningMessageId(reasoningId);
      if (!parsed) return state;
      return ensureReasoningPart(state, reasoningId, parsed.parentMessageId);
    }

    case EventType.REASONING_MESSAGE_CONTENT: {
      const reasoningId = getField<string>(event, "messageId");
      const delta = getField<string>(event, "delta");
      if (!reasoningId || !delta) return state;
      const parsed = parseReasoningMessageId(reasoningId);
      if (!parsed) return state;
      const prepared = ensureReasoningPart(
        state,
        reasoningId,
        parsed.parentMessageId,
      );
      return appendReasoningDelta(prepared, reasoningId, delta);
    }

    case EventType.REASONING_MESSAGE_END: {
      return state;
    }

    case EventType.TOOL_CALL_START: {
      const toolCallId = getField<string>(event, "toolCallId");
      const toolCallName = getField<string>(event, "toolCallName");
      if (!toolCallId || !toolCallName) return state;
      const parentMessageId = getField<string>(event, "parentMessageId");
      const targetMessageId =
        parentMessageId ??
        state.activeAssistantMessageId ??
        // Legacy-equivalent: orphan tool calls get a synthetic assistant
        // message so they still render in their own bubble.
        `agent-${toolCallId}`;

      const { messages: withMessage, changed: messageChanged } =
        ensureAssistantMessage(state.messages, targetMessageId, state.agent);
      const { messages: withTool, changed: toolChanged } = addPendingToolPart(
        withMessage,
        targetMessageId,
        toolCallId,
        toolCallName,
        state.agent,
      );

      const nextMessages =
        messageChanged || toolChanged ? withTool : state.messages;
      const nextActive = state.activeAssistantMessageId ?? targetMessageId;
      const buffers =
        toolCallId in state.toolArgsBuffers
          ? state.toolArgsBuffers
          : { ...state.toolArgsBuffers, [toolCallId]: "" };

      if (
        !messageChanged &&
        !toolChanged &&
        nextActive === state.activeAssistantMessageId &&
        state.toolArgsBuffers[toolCallId] === ""
      ) {
        return state;
      }

      return {
        ...state,
        messages: nextMessages,
        activeAssistantMessageId: nextActive,
        toolArgsBuffers: buffers,
      };
    }

    case EventType.TOOL_CALL_ARGS: {
      const toolCallId = getField<string>(event, "toolCallId");
      const delta = getField<string>(event, "delta");
      if (!toolCallId || !delta) return state;
      const prev = state.toolArgsBuffers[toolCallId] ?? "";
      return {
        ...state,
        toolArgsBuffers: {
          ...state.toolArgsBuffers,
          [toolCallId]: prev + delta,
        },
      };
    }

    case EventType.TOOL_CALL_CHUNK: {
      const toolCallId = getField<string>(event, "toolCallId");
      const delta = getField<string>(event, "delta");
      if (!toolCallId || !delta) return state;
      const { messages, changed } = appendToolProgressChunk(
        state.messages,
        toolCallId,
        delta,
      );
      return changed ? { ...state, messages } : state;
    }

    case EventType.TOOL_CALL_END: {
      const toolCallId = getField<string>(event, "toolCallId");
      if (!toolCallId) return state;
      const raw = state.toolArgsBuffers[toolCallId];
      if (raw === undefined) return state;
      const parsed = safeParseJson(raw);
      const { messages, changed } = updateToolPartParameters(
        state.messages,
        toolCallId,
        parsed,
      );
      const toolArgsBuffers = removeToolArgsBuffer(
        state.toolArgsBuffers,
        toolCallId,
      );
      if (!changed && toolArgsBuffers === state.toolArgsBuffers) return state;
      return {
        ...state,
        messages: changed ? messages : state.messages,
        toolArgsBuffers,
      };
    }

    case EventType.TOOL_CALL_RESULT: {
      const toolCallId = getField<string>(event, "toolCallId");
      const content = getField<unknown>(event, "content");
      if (!toolCallId || content === undefined) return state;
      // AG-UI uses `role: "tool"` for normal tool-result messages. Treat
      // only explicit error fields/status as failure.
      const error = getField<unknown>(event, "error");
      const status = getField<string>(event, "status");
      const isError =
        getField<boolean>(event, "isError") === true ||
        status === "error" ||
        typeof error === "string";
      const resultText =
        typeof content === "string" ? content : safeStringify(content);
      const { messages, changed } = completeToolPart(
        state.messages,
        toolCallId,
        resultText,
        isError,
      );
      const toolArgsBuffers = removeToolArgsBuffer(
        state.toolArgsBuffers,
        toolCallId,
      );
      if (!changed && toolArgsBuffers === state.toolArgsBuffers) return state;
      return {
        ...state,
        messages: changed ? messages : state.messages,
        toolArgsBuffers,
      };
    }

    case EventType.CUSTOM: {
      const dataPart = terragonDataPartFromCustomEvent(event);
      if (!dataPart) return state;
      const messageId = dataPart.data.messageId;
      const part = dataPart.data.data;
      if (!isRenderablePart(part)) return state;
      const normalizedPart = normalizeRenderablePart(part);
      const { messages, changed } = insertRichPart(
        state.messages,
        messageId,
        normalizedPart,
        state.agent,
      );
      return changed ? { ...state, messages } : state;
    }

    case EventType.MESSAGES_SNAPSHOT: {
      const snapshotMessages = getField<unknown>(event, "messages");
      if (!Array.isArray(snapshotMessages)) return state;
      const projectedMessages = snapshotMessages
        .map((message) => agUiSnapshotMessageToUiMessage(message, state.agent))
        .filter((message): message is UIMessage => message !== null);
      if (projectedMessages.length === 0) return state;
      const { messages, changed } = appendSnapshotMessages(
        state.messages,
        projectedMessages,
      );
      return changed ? { ...state, messages } : state;
    }

    case EventType.RUN_FINISHED: {
      const { messages, changed } = failPendingToolParts(
        state.messages,
        "Tool call ended without a result.",
      );
      const toolArgsBuffers =
        Object.keys(state.toolArgsBuffers).length > 0
          ? {}
          : state.toolArgsBuffers;
      if (!changed && toolArgsBuffers === state.toolArgsBuffers) return state;
      return {
        ...state,
        messages: changed ? messages : state.messages,
        toolArgsBuffers,
      };
    }

    case EventType.RUN_ERROR: {
      const errorMessage =
        getField<string>(event, "message") ??
        "Run ended before this tool returned a result.";
      const { messages, changed } = failPendingToolParts(
        state.messages,
        errorMessage,
      );
      const toolArgsBuffers =
        Object.keys(state.toolArgsBuffers).length > 0
          ? {}
          : state.toolArgsBuffers;
      if (!changed && toolArgsBuffers === state.toolArgsBuffers) return state;
      return {
        ...state,
        messages: changed ? messages : state.messages,
        toolArgsBuffers,
      };
    }

    case EventType.TEXT_MESSAGE_CHUNK:
    case EventType.THINKING_TEXT_MESSAGE_START:
    case EventType.THINKING_TEXT_MESSAGE_CONTENT:
    case EventType.THINKING_TEXT_MESSAGE_END:
    case EventType.THINKING_START:
    case EventType.THINKING_END:
    case EventType.STATE_SNAPSHOT:
    case EventType.STATE_DELTA:
    case EventType.ACTIVITY_SNAPSHOT:
    case EventType.ACTIVITY_DELTA:
    case EventType.RAW:
    case EventType.RUN_STARTED:
    case EventType.STEP_STARTED:
    case EventType.STEP_FINISHED:
    case EventType.REASONING_START:
    case EventType.REASONING_MESSAGE_CHUNK:
    case EventType.REASONING_END:
    case EventType.REASONING_ENCRYPTED_VALUE:
      return state;

    default: {
      const _exhaustiveCheck: never = eventType;
      return _exhaustiveCheck;
    }
  }
}

// ---------------------------------------------------------------------------
// Immutable helpers on UIMessage[]
// ---------------------------------------------------------------------------

function ensureAssistantMessage(
  messages: UIMessage[],
  messageId: string,
  agent: AIAgent,
): { messages: UIMessage[]; changed: boolean } {
  const idx = messages.findIndex(
    (m) => m.role === "agent" && m.id === messageId,
  );
  if (idx >= 0) {
    return { messages, changed: false };
  }
  const newMessage: UIAgentMessage = {
    id: messageId,
    role: "agent",
    agent,
    parts: [],
  };
  return { messages: [...messages, newMessage], changed: true };
}

function applyTextDelta(
  state: AgUiMessagesState,
  messageId: string,
  delta: string,
): AgUiMessagesState {
  const { messages: withMessage } = ensureAssistantMessage(
    state.messages,
    messageId,
    state.agent,
  );
  const nextMessages = withMessage.map((m) => {
    if (m.role !== "agent" || m.id !== messageId) return m;
    const parts = m.parts.slice();
    const lastIdx = findLastIndex(parts, (p) => p.type === "text");
    if (lastIdx >= 0) {
      const last = parts[lastIdx]!;
      if (last.type === "text") {
        parts[lastIdx] = { ...last, text: last.text + delta };
      }
    } else {
      parts.push({ type: "text", text: delta });
    }
    return { ...m, parts };
  });
  return {
    ...state,
    messages: nextMessages,
    activeAssistantMessageId: messageId,
  };
}

function ensureReasoningPart(
  state: AgUiMessagesState,
  reasoningId: string,
  parentMessageId: string,
): AgUiMessagesState {
  if (state.reasoningPartPositions[reasoningId]) {
    // Already tracked; only make sure the assistant message still exists
    // (it should — reasoningPartPositions is only set after the message
    // is added, and the reducer never removes messages).
    return state;
  }
  const { messages: withMessage } = ensureAssistantMessage(
    state.messages,
    parentMessageId,
    state.agent,
  );
  let partsIndex = -1;
  const next = withMessage.map((m) => {
    if (m.role !== "agent" || m.id !== parentMessageId) return m;
    partsIndex = m.parts.length;
    return {
      ...m,
      parts: [...m.parts, { type: "thinking", thinking: "" } as UIPart],
    };
  });
  if (partsIndex < 0) return state;
  return {
    ...state,
    messages: next,
    reasoningPartPositions: {
      ...state.reasoningPartPositions,
      [reasoningId]: { parentMessageId, partsIndex },
    },
  };
}

function appendReasoningDelta(
  state: AgUiMessagesState,
  reasoningId: string,
  delta: string,
): AgUiMessagesState {
  const pos = state.reasoningPartPositions[reasoningId];
  if (!pos) return state;
  const next = state.messages.map((m) => {
    if (m.role !== "agent" || m.id !== pos.parentMessageId) return m;
    const part = m.parts[pos.partsIndex];
    if (!part || part.type !== "thinking") return m;
    const parts = m.parts.slice();
    parts[pos.partsIndex] = {
      ...part,
      thinking: part.thinking + delta,
    } as UIPart;
    return { ...m, parts };
  });
  return { ...state, messages: next };
}

function addPendingToolPart(
  messages: UIMessage[],
  messageId: string,
  toolCallId: string,
  toolName: string,
  agent: AIAgent,
): { messages: UIMessage[]; changed: boolean } {
  let changed = false;
  const next = messages.map((m) => {
    if (m.role !== "agent" || m.id !== messageId) return m;
    const existing = m.parts.findIndex(
      (p) => p.type === "tool" && p.id === toolCallId,
    );
    if (existing >= 0) return m;
    changed = true;
    return {
      ...m,
      parts: [
        ...m.parts,
        {
          type: "tool",
          id: toolCallId,
          agent,
          name: toolName,
          parameters: {} as Record<string, unknown>,
          status: "pending",
          parts: [],
        } as unknown as UIPart,
      ],
    };
  });
  return { messages: next, changed };
}

function updateToolPartParameters(
  messages: UIMessage[],
  toolCallId: string,
  parameters: Record<string, unknown>,
): { messages: UIMessage[]; changed: boolean } {
  let changed = false;
  const next = messages.map((m) => {
    if (m.role !== "agent") return m;
    const idx = m.parts.findIndex(
      (p) => p.type === "tool" && p.id === toolCallId,
    );
    if (idx < 0) return m;
    const part = m.parts[idx]!;
    if (part.type !== "tool") return m;
    const nextParts = m.parts.slice();
    nextParts[idx] = { ...part, parameters } as UIPart;
    changed = true;
    return { ...m, parts: nextParts };
  });
  return { messages: next, changed };
}

function appendToolProgressChunk(
  messages: UIMessage[],
  toolCallId: string,
  text: string,
): { messages: UIMessage[]; changed: boolean } {
  let changed = false;
  const next = messages.map((m) => {
    if (m.role !== "agent") return m;
    const idx = m.parts.findIndex(
      (p) => p.type === "tool" && p.id === toolCallId,
    );
    if (idx < 0) return m;
    const part = m.parts[idx]!;
    if (part.type !== "tool") return m;
    const progressPart = part as ToolPartWithProgress;
    const existing = progressPart.progressChunks ?? [];
    const previousSeq = existing.at(-1)?.seq ?? -1;
    const nextProgressChunks = [...existing, { seq: previousSeq + 1, text }];
    const overflow = Math.max(
      0,
      nextProgressChunks.length - MAX_PROGRESS_CHUNKS,
    );
    const nextParts = m.parts.slice();
    nextParts[idx] = {
      ...progressPart,
      progressChunks: nextProgressChunks.slice(-MAX_PROGRESS_CHUNKS),
      progressHiddenCount: (progressPart.progressHiddenCount ?? 0) + overflow,
      toolStatus: "in_progress",
    } as unknown as UIPart;
    changed = true;
    return { ...m, parts: nextParts };
  });
  return { messages: next, changed };
}

function removeToolArgsBuffer(
  buffers: AgUiMessagesState["toolArgsBuffers"],
  toolCallId: string,
): AgUiMessagesState["toolArgsBuffers"] {
  if (!(toolCallId in buffers)) {
    return buffers;
  }
  const next = { ...buffers };
  delete next[toolCallId];
  return next;
}

function completeToolPart(
  messages: UIMessage[],
  toolCallId: string,
  result: string,
  isError: boolean,
): { messages: UIMessage[]; changed: boolean } {
  let changed = false;
  const next = messages.map((m) => {
    if (m.role !== "agent") return m;
    const idx = m.parts.findIndex(
      (p) => p.type === "tool" && p.id === toolCallId,
    );
    if (idx < 0) return m;
    const part = m.parts[idx]!;
    if (part.type !== "tool") return m;
    const progressPart = part as ToolPartWithProgress;
    const shouldCarryToolStatus =
      Boolean(progressPart.toolStatus) ||
      Boolean(progressPart.progressChunks?.length);
    const nextParts = m.parts.slice();
    nextParts[idx] = {
      ...part,
      status: isError ? "error" : "completed",
      ...(shouldCarryToolStatus
        ? { toolStatus: isError ? "failed" : "completed" }
        : {}),
      result,
    } as UIPart;
    changed = true;
    return { ...m, parts: nextParts };
  });
  return { messages: next, changed };
}

function failPendingToolParts(
  messages: UIMessage[],
  result: string,
): { messages: UIMessage[]; changed: boolean } {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== "agent") return message;
    let changedMessage = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool" || part.status !== "pending") {
        return part;
      }
      changed = true;
      changedMessage = true;
      return {
        ...part,
        status: "error",
        result,
      } as UIPart;
    });
    return changedMessage ? { ...message, parts } : message;
  });
  return { messages: next, changed };
}

function insertRichPart(
  messages: UIMessage[],
  messageId: string,
  part: UIPartExtended,
  agent: AIAgent,
): { messages: UIMessage[]; changed: boolean } {
  const { messages: withMessage, changed: created } = ensureAssistantMessage(
    messages,
    messageId,
    agent,
  );
  let changed = created;
  const next = withMessage.map((m) => {
    if (m.role !== "agent" || m.id !== messageId) return m;
    // Dedupe by id-like identity when present. Rich parts without an id
    // (terminal / diff / image) are appended each time; the backend's
    // `(runId, eventId)` dedupe at the SSE layer prevents real
    // duplicates in practice.
    const partIdentity = getPartIdentity(part);
    if (partIdentity.id) {
      const dup = m.parts.some((p) => {
        const existingIdentity = getPartIdentity(p);
        return (
          existingIdentity.type === partIdentity.type &&
          existingIdentity.id === partIdentity.id
        );
      });
      if (dup) return m;
    }
    changed = true;
    return {
      ...m,
      parts: [...m.parts, part as UIPart],
    };
  });
  return { messages: next, changed };
}

function appendSnapshotMessages(
  current: UIMessage[],
  incoming: UIMessage[],
): { messages: UIMessage[]; changed: boolean } {
  const existingIds = new Set(current.map((message) => message.id));
  const missing = incoming.filter((message) => !existingIds.has(message.id));
  if (missing.length === 0) {
    return { messages: current, changed: false };
  }
  return { messages: [...current, ...missing], changed: true };
}

function agUiSnapshotMessageToUiMessage(
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

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function getField<T>(value: unknown, key: string): T | undefined {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, T>)[key];
}

function parseReasoningMessageId(
  id: string,
): { parentMessageId: string; partIndex: number } | null {
  // Backend format: `<parentMessageId>:thinking:<partIndex>`. The parent
  // id itself may contain colons, so split from the right.
  const markerIdx = id.lastIndexOf(REASONING_MARKER);
  if (markerIdx < 0) return null;
  const parentMessageId = id.slice(0, markerIdx);
  const partIndexStr = id.slice(markerIdx + REASONING_MARKER.length);
  const partIndex = parseInt(partIndexStr, 10);
  if (!Number.isFinite(partIndex) || partIndex < 0) return null;
  if (parentMessageId.length === 0) return null;
  return { parentMessageId, partIndex };
}

function findLastIndex<T>(
  arr: readonly T[],
  predicate: (item: T) => boolean,
): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return i;
  }
  return -1;
}

function safeParseJson(raw: string): Record<string, unknown> {
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRenderablePart(value: unknown): value is UIPartExtended {
  if (!value || typeof value !== "object") return false;
  const type = getField<string>(value, "type");
  switch (type) {
    case "text":
      return typeof getField<unknown>(value, "text") === "string";
    case "thinking":
      return typeof getField<unknown>(value, "thinking") === "string";
    case "image":
      return typeof getField<unknown>(value, "image_url") === "string";
    case "rich-text":
      return Array.isArray(getField<unknown>(value, "nodes"));
    case "pdf":
      return typeof getField<unknown>(value, "pdf_url") === "string";
    case "text-file":
      return typeof getField<unknown>(value, "file_url") === "string";
    case "plan":
      return (
        typeof getField<unknown>(value, "planText") === "string" ||
        (Array.isArray(getField<unknown>(value, "entries")) &&
          (getField<unknown>(value, "entries") as unknown[]).every(
            isValidPlanEntryShape,
          ))
      );
    case "tool":
      return (
        typeof getField<unknown>(value, "id") === "string" &&
        typeof getField<unknown>(value, "name") === "string" &&
        Array.isArray(getField<unknown>(value, "parts"))
      );
    case "delegation":
      return (
        typeof getField<unknown>(value, "id") === "string" &&
        typeof getField<unknown>(value, "agentName") === "string" &&
        typeof getField<unknown>(value, "message") === "string" &&
        typeof getField<unknown>(value, "status") === "string"
      );
    case "audio":
    case "resource-link":
    case "terminal":
    case "diff":
    case "auto-approval-review":
    case "plan-structured":
    case "server-tool-use":
    case "web-search-result":
      return true;
    default:
      const _exhaustiveCheck = type satisfies string | undefined;
      void _exhaustiveCheck;
      return false;
  }
}

function isValidPlanEntryShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const content = getField<unknown>(value, "content");
  const priority = getField<unknown>(value, "priority");
  const status = getField<unknown>(value, "status");
  return (
    typeof content === "string" &&
    (priority === "high" || priority === "medium" || priority === "low") &&
    (status === "pending" ||
      status === "in_progress" ||
      status === "completed" ||
      status === "failed")
  );
}

function normalizeRenderablePart(part: UIPartExtended): UIPartExtended {
  if (
    part.type === "plan" &&
    "entries" in part &&
    Array.isArray(part.entries)
  ) {
    return {
      type: "plan-structured",
      entries: part.entries,
    };
  }
  return part;
}

function getPartIdentity(part: UIPartExtended): {
  type: string;
  id: string | null;
} {
  const id = getField<unknown>(part, "id");
  return {
    type: part.type,
    id: typeof id === "string" ? id : null,
  };
}
