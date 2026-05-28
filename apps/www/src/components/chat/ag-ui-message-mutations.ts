import type { UIAgentMessage, UIMessage, UIPart } from "@terragon/shared";
import { getPartIdentity } from "./ag-ui-part-validation";
import type { AgUiMessagesState } from "./ag-ui-reducer-utils";
import {
  MAX_PROGRESS_CHUNKS,
  type ToolProgressChunk,
} from "./tool-progress-chunks";
import type { UIPartExtended } from "./ui-parts-extended";

type ToolStatus = "started" | "in_progress" | "completed" | "failed";
type ToolPartWithProgress = UIPart & {
  type: "tool";
  id: string;
  progressChunks?: ToolProgressChunk[];
  progressHiddenCount?: number;
  toolStatus?: ToolStatus;
};

export function ensureAssistantMessage(
  state: AgUiMessagesState,
  messageId: string,
): { state: AgUiMessagesState; messageIndex: number; changed: boolean } {
  const existingIndex = state.assistantMessageIndexes[messageId];
  if (existingIndex !== undefined) {
    return { state, messageIndex: existingIndex, changed: false };
  }
  const newMessage: UIAgentMessage = {
    id: messageId,
    role: "agent",
    agent: state.agent,
    parts: [],
  };
  const messageIndex = state.messages.length;
  return {
    state: {
      ...state,
      messages: [...state.messages, newMessage],
      messageIndexes: {
        ...state.messageIndexes,
        [messageId]: messageIndex,
      },
      assistantMessageIndexes: {
        ...state.assistantMessageIndexes,
        [messageId]: messageIndex,
      },
    },
    messageIndex,
    changed: true,
  };
}

export function applyTextDelta(
  state: AgUiMessagesState,
  messageId: string,
  delta: string,
): AgUiMessagesState {
  const prepared = ensureAssistantMessage(state, messageId);
  const message = prepared.state.messages[prepared.messageIndex];
  if (!message || message.role !== "agent") {
    return state;
  }
  const parts = message.parts.slice();
  const lastIdx = findLastIndex(parts, (p) => p.type === "text");
  if (lastIdx >= 0) {
    const last = parts[lastIdx]!;
    if (last.type === "text") {
      parts[lastIdx] = { ...last, text: last.text + delta };
    }
  } else {
    parts.push({ type: "text", text: delta });
  }
  return {
    ...prepared.state,
    messages: replaceMessage(prepared.state.messages, prepared.messageIndex, {
      ...message,
      parts,
    }),
    activeAssistantMessageId: messageId,
  };
}

export function ensureReasoningPart(
  state: AgUiMessagesState,
  reasoningId: string,
  parentMessageId: string,
): AgUiMessagesState {
  if (state.reasoningPartPositions[reasoningId]) {
    return state;
  }
  const prepared = ensureAssistantMessage(state, parentMessageId);
  const message = prepared.state.messages[prepared.messageIndex];
  if (!message || message.role !== "agent") {
    return state;
  }
  const partsIndex = message.parts.length;
  return {
    ...prepared.state,
    messages: replaceMessage(prepared.state.messages, prepared.messageIndex, {
      ...message,
      parts: [...message.parts, { type: "thinking", thinking: "" } as UIPart],
    }),
    reasoningPartPositions: {
      ...prepared.state.reasoningPartPositions,
      [reasoningId]: { parentMessageId, partsIndex },
    },
  };
}

export function appendReasoningDelta(
  state: AgUiMessagesState,
  reasoningId: string,
  delta: string,
): AgUiMessagesState {
  const pos = state.reasoningPartPositions[reasoningId];
  if (!pos) return state;
  const messageIndex = state.assistantMessageIndexes[pos.parentMessageId];
  if (messageIndex === undefined) return state;
  const message = state.messages[messageIndex];
  if (!message || message.role !== "agent") return state;
  const part = message.parts[pos.partsIndex];
  if (!part || part.type !== "thinking") return state;
  const parts = message.parts.slice();
  parts[pos.partsIndex] = {
    ...part,
    thinking: part.thinking + delta,
  } as UIPart;
  return {
    ...state,
    messages: replaceMessage(state.messages, messageIndex, {
      ...message,
      parts,
    }),
  };
}

export function addPendingToolPart(
  state: AgUiMessagesState,
  messageId: string,
  toolCallId: string,
  toolName: string,
): { state: AgUiMessagesState; changed: boolean } {
  if (state.toolPartPositions[toolCallId]) {
    return { state, changed: false };
  }
  const messageIndex = state.assistantMessageIndexes[messageId];
  if (messageIndex === undefined) {
    return { state, changed: false };
  }
  const message = state.messages[messageIndex];
  if (!message || message.role !== "agent") {
    return { state, changed: false };
  }
  const partsIndex = message.parts.length;
  const toolPart = {
    type: "tool",
    id: toolCallId,
    agent: state.agent,
    name: toolName,
    parameters: {} as Record<string, unknown>,
    status: "pending",
    parts: [],
  } as unknown as UIPart;
  return {
    state: {
      ...state,
      messages: replaceMessage(state.messages, messageIndex, {
        ...message,
        parts: [...message.parts, toolPart],
      }),
      toolPartPositions: {
        ...state.toolPartPositions,
        [toolCallId]: { messageId, partsIndex },
      },
    },
    changed: true,
  };
}

export function updateToolPartParameters(
  state: AgUiMessagesState,
  toolCallId: string,
  parameters: Record<string, unknown>,
): AgUiMessagesState {
  return updateToolPart(state, toolCallId, (part) => ({
    ...part,
    parameters,
  }));
}

export function appendToolProgressChunk(
  state: AgUiMessagesState,
  toolCallId: string,
  text: string,
): AgUiMessagesState {
  return updateToolPart(state, toolCallId, (part) => {
    const progressPart = part as ToolPartWithProgress;
    const existing = progressPart.progressChunks ?? [];
    const previousSeq = existing.at(-1)?.seq ?? -1;
    const nextProgressChunks = [...existing, { seq: previousSeq + 1, text }];
    const overflow = Math.max(
      0,
      nextProgressChunks.length - MAX_PROGRESS_CHUNKS,
    );
    return {
      ...progressPart,
      progressChunks: nextProgressChunks.slice(-MAX_PROGRESS_CHUNKS),
      progressHiddenCount: (progressPart.progressHiddenCount ?? 0) + overflow,
      toolStatus: "in_progress",
    } as unknown as UIPart;
  });
}

export function removeToolArgsBuffer(
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

export function completeToolPart(
  state: AgUiMessagesState,
  toolCallId: string,
  result: string,
  isError: boolean,
): AgUiMessagesState {
  return updateToolPart(state, toolCallId, (part) => {
    const progressPart = part as ToolPartWithProgress;
    const shouldCarryToolStatus =
      Boolean(progressPart.toolStatus) ||
      Boolean(progressPart.progressChunks?.length);
    return {
      ...part,
      status: isError ? "error" : "completed",
      ...(shouldCarryToolStatus
        ? { toolStatus: isError ? "failed" : "completed" }
        : {}),
      result,
    } as UIPart;
  });
}

export function failPendingToolParts(
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

export function insertRichPart(
  state: AgUiMessagesState,
  messageId: string,
  part: UIPartExtended,
): AgUiMessagesState {
  const prepared = ensureAssistantMessage(state, messageId);
  const message = prepared.state.messages[prepared.messageIndex];
  if (!message || message.role !== "agent") {
    return state;
  }
  const partIdentity = getPartIdentity(part);
  if (partIdentity.id) {
    const dup = message.parts.some((existingPart) => {
      const existingIdentity = getPartIdentity(existingPart);
      return (
        existingIdentity.type === partIdentity.type &&
        existingIdentity.id === partIdentity.id
      );
    });
    if (dup) {
      return prepared.state;
    }
  }
  return {
    ...prepared.state,
    messages: replaceMessage(prepared.state.messages, prepared.messageIndex, {
      ...message,
      parts: [...message.parts, part as UIPart],
    }),
  };
}

export function appendSnapshotMessages(
  state: AgUiMessagesState,
  incoming: UIMessage[],
): AgUiMessagesState {
  const missing = incoming.filter(
    (message) => state.messageIndexes[message.id] === undefined,
  );
  if (missing.length === 0) {
    return state;
  }
  const messageIndexes = { ...state.messageIndexes };
  const assistantMessageIndexes = { ...state.assistantMessageIndexes };
  const toolPartPositions = { ...state.toolPartPositions };
  let nextMessageIndex = state.messages.length;
  for (const message of missing) {
    messageIndexes[message.id] = nextMessageIndex;
    if (message.role === "agent") {
      assistantMessageIndexes[message.id] = nextMessageIndex;
      message.parts.forEach((part, partsIndex) => {
        if (part.type === "tool") {
          toolPartPositions[part.id] = {
            messageId: message.id,
            partsIndex,
          };
        }
      });
    }
    nextMessageIndex += 1;
  }
  return {
    ...state,
    messages: [...state.messages, ...missing],
    messageIndexes,
    assistantMessageIndexes,
    toolPartPositions,
  };
}

function updateToolPart(
  state: AgUiMessagesState,
  toolCallId: string,
  update: (part: Extract<UIPart, { type: "tool" }>) => UIPart,
): AgUiMessagesState {
  const position = state.toolPartPositions[toolCallId];
  if (!position) return state;
  const messageIndex = state.assistantMessageIndexes[position.messageId];
  if (messageIndex === undefined) return state;
  const message = state.messages[messageIndex];
  if (!message || message.role !== "agent") return state;
  const part = message.parts[position.partsIndex];
  if (!part || part.type !== "tool") return state;
  const parts = message.parts.slice();
  parts[position.partsIndex] = update(part);
  return {
    ...state,
    messages: replaceMessage(state.messages, messageIndex, {
      ...message,
      parts,
    }),
  };
}

function replaceMessage(
  messages: UIMessage[],
  index: number,
  message: UIMessage,
): UIMessage[] {
  const next = messages.slice();
  next[index] = message;
  return next;
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
