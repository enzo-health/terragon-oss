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
import type { UIMessage } from "@terragon/shared";
import {
  addPendingToolPart,
  appendReasoningDelta,
  appendSnapshotMessages,
  appendToolProgressChunk,
  applyTextDelta,
  completeToolPart,
  ensureAssistantMessage,
  ensureReasoningPart,
  failPendingToolParts,
  insertRichPart,
  removeToolArgsBuffer,
  updateToolPartParameters,
} from "./ag-ui-message-mutations";
import {
  isRenderablePart,
  normalizeRenderablePart,
} from "./ag-ui-part-validation";
import {
  type AgUiMessagesState,
  createAgUiMessageIndexes,
  getField,
  safeStringify,
} from "./ag-ui-reducer-utils";
import { agUiSnapshotMessageToUiMessage } from "./ag-ui-snapshot-projection";
import { terragonDataPartFromCustomEvent } from "./ag-ui-custom-parts";

export type { AgUiMessagesState };

const REASONING_MARKER = ":thinking:";

export function createInitialAgUiMessagesState(
  agent: AIAgent,
  initialMessages: UIMessage[],
): AgUiMessagesState {
  const indexes = createAgUiMessageIndexes(initialMessages);
  return {
    messages: initialMessages.slice(),
    ...indexes,
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
      const prepared = ensureAssistantMessage(state, messageId);
      const nextActive = messageId;
      if (!prepared.changed && state.activeAssistantMessageId === nextActive) {
        return state;
      }
      return {
        ...prepared.state,
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

      const prepared = ensureAssistantMessage(state, targetMessageId);
      const withTool = addPendingToolPart(
        prepared.state,
        targetMessageId,
        toolCallId,
        toolCallName,
      );

      const nextActive = state.activeAssistantMessageId ?? targetMessageId;
      const buffers =
        toolCallId in state.toolArgsBuffers
          ? withTool.state.toolArgsBuffers
          : { ...withTool.state.toolArgsBuffers, [toolCallId]: "" };

      if (
        !prepared.changed &&
        !withTool.changed &&
        nextActive === state.activeAssistantMessageId &&
        state.toolArgsBuffers[toolCallId] === ""
      ) {
        return state;
      }

      return {
        ...withTool.state,
        activeAssistantMessageId: nextActive,
        toolArgsBuffers: buffers,
      };
    }

    case EventType.TOOL_CALL_ARGS: {
      const toolCallId = getField<string>(event, "toolCallId");
      const delta = getField<string>(event, "delta");
      if (!toolCallId || !delta) return state;
      const prev = state.toolArgsBuffers[toolCallId] ?? "";
      const raw = prev + delta;
      const nextState = {
        ...state,
        toolArgsBuffers: {
          ...state.toolArgsBuffers,
          [toolCallId]: raw,
        },
      };
      const parsed = safeParseJson(raw);
      if (Object.keys(parsed).length === 0) {
        return nextState;
      }
      return updateToolPartParameters(nextState, toolCallId, parsed);
    }

    case EventType.TOOL_CALL_CHUNK: {
      const toolCallId = getField<string>(event, "toolCallId");
      const delta = getField<string>(event, "delta");
      if (!toolCallId || !delta) return state;
      return appendToolProgressChunk(state, toolCallId, delta);
    }

    case EventType.TOOL_CALL_END: {
      const toolCallId = getField<string>(event, "toolCallId");
      if (!toolCallId) return state;
      const raw = state.toolArgsBuffers[toolCallId];
      if (raw === undefined) return state;
      const parsed = safeParseJson(raw);
      const withParameters =
        Object.keys(parsed).length > 0
          ? updateToolPartParameters(state, toolCallId, parsed)
          : state;
      const toolArgsBuffers = removeToolArgsBuffer(
        withParameters.toolArgsBuffers,
        toolCallId,
      );
      if (
        withParameters === state &&
        toolArgsBuffers === state.toolArgsBuffers
      ) {
        return state;
      }
      return {
        ...withParameters,
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
      const withResult = completeToolPart(
        state,
        toolCallId,
        resultText,
        isError,
      );
      const toolArgsBuffers = removeToolArgsBuffer(
        withResult.toolArgsBuffers,
        toolCallId,
      );
      if (withResult === state && toolArgsBuffers === state.toolArgsBuffers) {
        return state;
      }
      return {
        ...withResult,
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
      return insertRichPart(state, messageId, normalizedPart);
    }

    case EventType.MESSAGES_SNAPSHOT: {
      const snapshotMessages = getField<unknown>(event, "messages");
      if (!Array.isArray(snapshotMessages)) return state;
      const projectedMessages = snapshotMessages
        .map((message) => agUiSnapshotMessageToUiMessage(message, state.agent))
        .filter((message): message is UIMessage => message !== null);
      if (projectedMessages.length === 0) return state;
      return appendSnapshotMessages(state, projectedMessages);
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
