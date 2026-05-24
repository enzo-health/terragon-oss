import type { AIAgent } from "@terragon/agent/types";
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

export function applyTextDelta(
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

export function ensureReasoningPart(
  state: AgUiMessagesState,
  reasoningId: string,
  parentMessageId: string,
): AgUiMessagesState {
  if (state.reasoningPartPositions[reasoningId]) {
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

export function appendReasoningDelta(
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

export function addPendingToolPart(
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

export function updateToolPartParameters(
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

export function appendToolProgressChunk(
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

export function appendSnapshotMessages(
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

function findLastIndex<T>(
  arr: readonly T[],
  predicate: (item: T) => boolean,
): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return i;
  }
  return -1;
}
