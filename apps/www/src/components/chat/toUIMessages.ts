import { useMemo, useRef } from "react";
import type { AIAgent } from "@terragon/agent/types";
import type {
  DBMessage,
  UIMessage,
  UIUserMessage,
  DBAgentMessagePart,
} from "@terragon/shared";
import type {
  UIAgentMessage,
  UIToolPart,
  UICompletedToolPart,
  UIPart,
  UIGitDiffPart,
  ThreadStatus,
} from "@terragon/shared";

/**
 * Convert a DBAgentMessage part to a UIPartExtended (the local www union),
 * returning null only for part types with no known renderer.
 */
function dbAgentPartToUIPart(part: DBAgentMessagePart): UIPartExtended | null {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "thinking":
      return { type: "thinking", thinking: part.thinking };
    case "image":
      return { type: "image", image_url: part.image_url };
    case "audio":
      return part; // UIAudioPart = DBAudioPart passthrough
    case "resource-link":
      return part; // UIResourceLinkPart = DBResourceLinkPart passthrough
    case "terminal":
      return part; // UITerminalPart = DBTerminalPart passthrough
    case "diff":
      return part; // UIDiffPart = DBDiffPart passthrough
    case "auto-approval-review":
      return part; // UIAutoApprovalReviewPart passthrough
    case "plan": {
      const structured: UIStructuredPlanPart = {
        type: "plan-structured",
        entries: part.entries,
      };
      return structured;
    }
    case "server-tool-use":
      return part; // UIServerToolUsePart = DBServerToolUsePart passthrough
    case "web-search-result":
      return part; // UIWebSearchResultPart = DBWebSearchResultPart passthrough
    default: {
      const _exhaustive: never = part;
      void _exhaustive;
      return null;
    }
  }
}
import type { UIPartExtended, UIStructuredPlanPart } from "./ui-parts-extended";
import type { DeltaAccumulator, DeltaChunk } from "@/hooks/useDeltaAccumulator";

type UIMessageRange = {
  startDbIndex: number;
  endDbIndex: number;
};

type UIMessagesBuildResult = {
  messages: UIMessage[];
  ranges: UIMessageRange[];
};

type IncrementalUIMessagesCache = UIMessagesBuildResult & {
  agent: AIAgent;
  cacheKey: string;
  dbMessages: DBMessage[];
};

/**
 * Extended UIToolPart that carries lifecycle metadata from DBToolCall.
 * The extra fields are not part of the shared UIToolPart type (Sprint 5 www-only
 * constraint), so they live here and are read via runtime access in tool-part.tsx.
 */
type InternalToolPart = UIToolPart<string, Record<string, any>> & {
  progressChunks?: Array<{ seq: number; text: string }>;
  mcpMetadata?: { server: string; tool: string };
  toolStatus?: "started" | "in_progress" | "completed" | "failed";
};

/**
 * Converts a collection of DBMessages to UIMessages.
 *
 * DBMessages store each interaction separately (user messages, agent messages, tool calls, tool results),
 * while UIMessages group tool calls and results as parts of agent messages.
 *
 * @param dbMessages - The messages from the database
 * @param threadStatus - Optional thread status to determine if pending tools should be marked complete
 */
export function toUIMessages({
  dbMessages,
  agent,
  threadStatus,
}: {
  dbMessages: DBMessage[];
  agent: AIAgent;
  threadStatus?: ThreadStatus | null;
}): UIMessage[] {
  return buildUIMessagesWithRanges({
    dbMessages,
    agent,
    threadStatus,
  }).messages;
}

export function useIncrementalUIMessages({
  dbMessages,
  agent,
  threadStatus,
  cacheKey,
  deltas,
}: {
  dbMessages: DBMessage[];
  agent: AIAgent;
  threadStatus?: ThreadStatus | null;
  cacheKey: string;
  deltas?: DeltaAccumulator;
}) {
  const cacheRef = useRef<IncrementalUIMessagesCache | null>(null);

  // Memo 1: Stable message tree — only rebuilds when dbMessages actually change.
  // This is the expensive path (walks the full message array, does range tracking).
  const builtMessages = useMemo(() => {
    const previous = cacheRef.current;
    const nextState = buildIncrementalUIMessages({
      previous,
      dbMessages,
      agent,
      threadStatus,
      cacheKey,
    });
    cacheRef.current = nextState;
    return nextState.messages;
  }, [agent, cacheKey, dbMessages, threadStatus]);

  // Memo 2: Append ephemeral delta text — cheap, runs on every delta arrival.
  // Only creates a new array + one synthetic message, never rebuilds the tree.
  return useMemo(() => {
    if (deltas && deltas.size > 0) {
      return appendDeltaMessages(builtMessages, agent, deltas);
    }
    return builtMessages;
  }, [builtMessages, agent, deltas]);
}

function buildIncrementalUIMessages({
  previous,
  dbMessages,
  agent,
  threadStatus,
  cacheKey,
}: {
  previous: IncrementalUIMessagesCache | null;
  dbMessages: DBMessage[];
  agent: AIAgent;
  threadStatus?: ThreadStatus | null;
  cacheKey: string;
}): IncrementalUIMessagesCache {
  if (
    previous === null ||
    previous.agent !== agent ||
    previous.cacheKey !== cacheKey ||
    !canReuseMessagePrefix(previous.dbMessages, dbMessages)
  ) {
    return {
      ...buildUIMessagesWithRanges({
        dbMessages,
        agent,
        threadStatus,
      }),
      agent,
      cacheKey,
      dbMessages,
    };
  }

  const rebuildStartDbIndex = getMutableTailStartDbIndex(dbMessages);
  if (rebuildStartDbIndex <= 0) {
    return {
      ...buildUIMessagesWithRanges({
        dbMessages,
        agent,
        threadStatus,
      }),
      agent,
      cacheKey,
      dbMessages,
    };
  }

  const stablePrefixCount = previous.ranges.findIndex(
    (range) => range.endDbIndex >= rebuildStartDbIndex,
  );
  const preservedCount =
    stablePrefixCount === -1 ? previous.messages.length : stablePrefixCount;
  const preservedMessages = previous.messages.slice(0, preservedCount);
  const preservedRanges = previous.ranges.slice(0, preservedCount);
  const rebuiltTail = buildUIMessagesWithRanges({
    dbMessages: dbMessages.slice(rebuildStartDbIndex),
    agent,
    threadStatus,
    dbStartIndex: rebuildStartDbIndex,
  });

  return {
    messages: [...preservedMessages, ...rebuiltTail.messages],
    ranges: [...preservedRanges, ...rebuiltTail.ranges],
    agent,
    cacheKey,
    dbMessages,
  };
}

function canReuseMessagePrefix(previous: DBMessage[], next: DBMessage[]) {
  if (next.length < previous.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index++) {
    if (previous[index] !== next[index]) {
      return false;
    }
  }
  return true;
}

function isTurnBoundaryMessage(message: DBMessage) {
  return (
    message.type === "user" ||
    message.type === "system" ||
    message.type === "git-diff" ||
    message.type === "stop" ||
    (message.type === "meta" && message.subtype === "result-success")
  );
}

function getMutableTailStartDbIndex(dbMessages: DBMessage[]) {
  for (let index = dbMessages.length - 1; index >= 0; index--) {
    const message = dbMessages[index];
    if (message && isTurnBoundaryMessage(message)) {
      return index;
    }
  }
  return 0;
}

function buildUIMessagesWithRanges({
  dbMessages,
  agent,
  threadStatus,
  dbStartIndex = 0,
}: {
  dbMessages: DBMessage[];
  agent: AIAgent;
  threadStatus?: ThreadStatus | null;
  dbStartIndex?: number;
}): UIMessagesBuildResult {
  const uiMessages: UIMessage[] = [];
  const ranges: UIMessageRange[] = [];
  let currentAgentMessage: UIAgentMessage | null = null;
  let currentUserMessage: UIUserMessage | null = null;
  let currentAgentMessageStartDbIndex: number | null = null;
  let currentUserMessageStartDbIndex: number | null = null;

  // Map to store tool parts by their ID for efficient lookup
  const toolPartsById: Record<string, InternalToolPart> = {};

  function markPendingToolsAsCompleted() {
    // Mark all pending tool calls as completed with a mock result
    for (const toolPart of Object.values(toolPartsById)) {
      if (toolPart.status === "pending") {
        // Add both status and a mock result to make it a proper UICompletedToolPart
        (toolPart as any).status = "completed";
        (toolPart as any).result = "[Tool execution was interrupted]";
      }
    }
  }

  function getOrCreateAgentMessage(): UIAgentMessage {
    if (currentAgentMessage) {
      return currentAgentMessage;
    }
    currentAgentMessageStartDbIndex = -1;
    currentAgentMessage = {
      id: `agent-${uiMessages.length}`,
      role: "agent",
      agent,
      parts: [],
    };
    return currentAgentMessage;
  }

  function getOrCreateUserMessage(): UIUserMessage {
    if (currentUserMessage) {
      return currentUserMessage;
    }
    currentUserMessageStartDbIndex = -1;
    currentUserMessage = {
      id: `user-${uiMessages.length}`,
      role: "user",
      parts: [],
    };
    return currentUserMessage;
  }

  function clearCurrentUserMessage(endDbIndex: number) {
    if (currentUserMessage) {
      uiMessages.push(currentUserMessage);
      ranges.push({
        startDbIndex: currentUserMessageStartDbIndex ?? endDbIndex,
        endDbIndex,
      });
      currentUserMessage = null;
      currentUserMessageStartDbIndex = null;
    }
  }

  function clearCurrentAgentMessage(endDbIndex: number) {
    if (currentAgentMessage) {
      uiMessages.push(currentAgentMessage);
      ranges.push({
        startDbIndex: currentAgentMessageStartDbIndex ?? endDbIndex,
        endDbIndex,
      });
      currentAgentMessage = null;
      currentAgentMessageStartDbIndex = null;
    }
  }

  function pushPart(parts: UIPart[], newPart: UIPartExtended) {
    if (newPart.type === "text" && newPart.text.trim() === "") {
      return;
    }
    // UIPartExtended is a superset of UIPart; the extra variants are handled
    // by the extended message-part.tsx dispatcher.
    parts.push(newPart as UIPart);
  }

  function replaceOrPushToolPart(parts: UIPart[], toolPart: InternalToolPart) {
    const existing = toolPartsById[toolPart.id];
    if (existing) {
      existing.name = toolPart.name;
      existing.parameters = toolPart.parameters;
      existing.status = "pending";
      return;
    }

    if (
      toolPart.name === "TodoWrite" &&
      parts.length > 0 &&
      parts[parts.length - 1]?.type === "tool" &&
      (parts[parts.length - 1] as InternalToolPart).name === "TodoWrite"
    ) {
      // Replace the last tool part with the new one
      parts[parts.length - 1] = toolPart;
    } else {
      pushPart(parts, toolPart);
    }
  }

  for (const [relativeIndex, dbMessage] of dbMessages.entries()) {
    const dbIndex = dbStartIndex + relativeIndex;
    if (dbMessage.type === "meta" && dbMessage.subtype === "result-success") {
      // Attach run stats to the preceding agent message before flushing
      if (currentAgentMessage && dbMessage.duration_ms > 0) {
        currentAgentMessage.meta = {
          cost_usd: dbMessage.cost_usd,
          duration_ms: dbMessage.duration_ms,
          num_turns: dbMessage.num_turns,
        };
      }
      clearCurrentAgentMessage(dbIndex);
      clearCurrentUserMessage(dbIndex);
      continue;
    }
    // Type guard for user messages
    if (dbMessage.type === "user") {
      // Mark any pending tools as completed before processing user message
      markPendingToolsAsCompleted();
      clearCurrentAgentMessage(dbIndex - 1);
      const userMessage = getOrCreateUserMessage();
      if (currentUserMessageStartDbIndex === -1) {
        currentUserMessageStartDbIndex = dbIndex;
      }
      for (const part of dbMessage.parts) {
        pushPart(userMessage.parts, part);
      }
      userMessage.timestamp = dbMessage.timestamp;
      userMessage.model = dbMessage.model;
    } else if (dbMessage.type === "system") {
      clearCurrentAgentMessage(dbIndex - 1);
      clearCurrentUserMessage(dbIndex - 1);
      uiMessages.push({
        id: `system-${dbIndex}`,
        role: "system",
        message_type: dbMessage.message_type,
        parts: dbMessage.parts,
      });
      ranges.push({ startDbIndex: dbIndex, endDbIndex: dbIndex });
    } else if (dbMessage.type === "agent") {
      clearCurrentUserMessage(dbIndex - 1);
      // Handle agent messages with parent_tool_use_id (nested inside a tool)
      if (dbMessage.parent_tool_use_id) {
        const found = toolPartsById[dbMessage.parent_tool_use_id];
        if (found) {
          // Add agent message parts to the parent tool's parts
          for (const part of dbMessage.parts) {
            const uiPart = dbAgentPartToUIPart(part);
            if (uiPart) pushPart(found.parts, uiPart);
          }
        }
      } else {
        currentAgentMessage = getOrCreateAgentMessage();
        if (currentAgentMessageStartDbIndex === -1) {
          currentAgentMessageStartDbIndex = dbIndex;
        }
        for (const part of dbMessage.parts) {
          const uiPart = dbAgentPartToUIPart(part);
          if (!uiPart) continue;
          // Merge consecutive text parts into one (e.g. ACP streams word-by-word)
          if (uiPart.type === "text") {
            const lastPart =
              currentAgentMessage.parts[currentAgentMessage.parts.length - 1];
            if (lastPart && lastPart.type === "text") {
              lastPart.text += uiPart.text;
              continue;
            }
          }
          // Merge consecutive thinking parts into one (same ACP streaming pattern)
          if (uiPart.type === "thinking") {
            const lastPart =
              currentAgentMessage.parts[currentAgentMessage.parts.length - 1];
            if (lastPart && lastPart.type === "thinking") {
              lastPart.thinking += uiPart.thinking;
              continue;
            }
          }
          pushPart(currentAgentMessage.parts, uiPart);
        }
      }
    } else if (dbMessage.type === "tool-call") {
      clearCurrentUserMessage(dbIndex - 1);
      const existingToolPart = toolPartsById[dbMessage.id];
      const newToolPart: InternalToolPart = {
        type: "tool",
        id: dbMessage.id,
        agent,
        name: dbMessage.name,
        parameters: dbMessage.parameters,
        status: "pending",
        parts: [],
        // Carry lifecycle metadata from DBToolCall (Sprint 5 www-only extension)
        ...(dbMessage.progressChunks
          ? { progressChunks: dbMessage.progressChunks }
          : {}),
        ...(dbMessage.mcpMetadata
          ? { mcpMetadata: dbMessage.mcpMetadata }
          : {}),
        ...(dbMessage.status ? { toolStatus: dbMessage.status } : {}),
      };
      // Handle tool calls with parent_tool_use_id (nested inside another tool)
      if (dbMessage.parent_tool_use_id) {
        const found = toolPartsById[dbMessage.parent_tool_use_id];
        if (found) {
          replaceOrPushToolPart(found.parts, newToolPart);
        }
      } else {
        currentAgentMessage = getOrCreateAgentMessage();
        if (currentAgentMessageStartDbIndex === -1) {
          currentAgentMessageStartDbIndex = dbIndex;
        }
        replaceOrPushToolPart(currentAgentMessage.parts, newToolPart);
      }
      if (!existingToolPart) {
        toolPartsById[dbMessage.id] = newToolPart;
      }
    } else if (dbMessage.type === "tool-result") {
      // Find the corresponding tool call and update it with result
      const found = toolPartsById[dbMessage.id];
      if (found) {
        found.status = dbMessage.is_error ? "error" : "completed";
        (found as UICompletedToolPart<string, any>).result = dbMessage.result;
      }
    } else if (dbMessage.type === "git-diff") {
      // Mark any pending tools as completed before processing git diff
      markPendingToolsAsCompleted();
      clearCurrentAgentMessage(dbIndex - 1);
      clearCurrentUserMessage(dbIndex - 1);

      // Add git-diff as a standalone agent message
      const gitDiffPart: UIGitDiffPart = {
        type: "git-diff",
        diff: dbMessage.diff,
        diffStats: dbMessage.diffStats || undefined,
        timestamp: dbMessage.timestamp,
        description: dbMessage.description,
      };
      uiMessages.push({
        id: `git-diff-${dbIndex}`,
        role: "system",
        message_type: "git-diff",
        parts: [gitDiffPart],
      });
      ranges.push({ startDbIndex: dbIndex, endDbIndex: dbIndex });
    } else if (dbMessage.type === "stop") {
      // Mark any pending tools as completed before processing stop
      markPendingToolsAsCompleted();
      clearCurrentAgentMessage(dbIndex - 1);
      clearCurrentUserMessage(dbIndex - 1);
      uiMessages.push({
        id: `stop-${dbIndex}`,
        role: "system",
        message_type: "stop",
        parts: [{ type: "stop" }],
      });
      ranges.push({ startDbIndex: dbIndex, endDbIndex: dbIndex });
    } else if (dbMessage.type === "error") {
      // Mark any pending tools as completed when agent encounters an error
      markPendingToolsAsCompleted();
      clearCurrentAgentMessage(dbIndex - 1);
      clearCurrentUserMessage(dbIndex - 1);
      // Handle error messages (they are not shown in UI messages based on tests)
    } else if (
      dbMessage.type === "meta" &&
      dbMessage.subtype === "result-error-max-turns"
    ) {
      // Mark any pending tools as completed when agent hits max turns
      markPendingToolsAsCompleted();
      // Meta messages are ignored in UI
    }
  }
  const lastDbIndex = dbStartIndex + dbMessages.length - 1;
  clearCurrentUserMessage(lastDbIndex);
  clearCurrentAgentMessage(lastDbIndex);

  // If thread is not actively working, mark any remaining pending tools as completed
  if (threadStatus && !isThreadWorking(threadStatus)) {
    markPendingToolsAsCompleted();
  }

  return {
    messages: uiMessages,
    ranges,
  };
}

/**
 * Appends a synthetic agent message from accumulated delta text.
 * Delta parts are grouped into a single trailing agent message so Streamdown
 * can render them as incrementally growing markdown.
 */
function appendDeltaMessages(
  messages: UIMessage[],
  agent: AIAgent,
  deltas: DeltaAccumulator,
): UIMessage[] {
  const firstSeenMessageOrder = new Map<string, number>();
  const parsed = Array.from(deltas.entries())
    .map(([key, chunk]) => {
      const segments = key.split(":");
      if (segments.length < 3) {
        return null;
      }
      const kindSegment = segments[segments.length - 1];
      const partIndexSegment = segments[segments.length - 2];
      const messageId = segments.slice(0, -2).join(":");
      const partIndex = parseInt(partIndexSegment ?? "", 10);
      if (!Number.isFinite(partIndex)) {
        return null;
      }
      if (kindSegment !== "text" && kindSegment !== "thinking") {
        return null;
      }
      if (!firstSeenMessageOrder.has(messageId)) {
        firstSeenMessageOrder.set(messageId, firstSeenMessageOrder.size);
      }
      return {
        messageId,
        partIndex,
        kind: kindSegment,
        firstDeltaSeq:
          typeof chunk.firstDeltaSeq === "number" ? chunk.firstDeltaSeq : null,
        chunk,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => {
      const messageOrderDelta =
        (firstSeenMessageOrder.get(a.messageId) ?? 0) -
        (firstSeenMessageOrder.get(b.messageId) ?? 0);
      if (messageOrderDelta !== 0) {
        return messageOrderDelta;
      }
      if (a.partIndex !== b.partIndex) {
        return a.partIndex - b.partIndex;
      }
      if (a.firstDeltaSeq != null && b.firstDeltaSeq != null) {
        if (a.firstDeltaSeq !== b.firstDeltaSeq) {
          return a.firstDeltaSeq - b.firstDeltaSeq;
        }
      }
      if (a.kind !== b.kind) {
        return a.kind === "thinking" ? -1 : 1;
      }
      return 0;
    });

  const parts: UIPart[] = parsed.map(({ chunk }) => toDeltaPart(chunk));

  if (parts.length === 0) return messages;

  const deltaMessage: UIAgentMessage = {
    id: "delta-streaming",
    role: "agent",
    agent,
    parts,
  };

  return [...messages, deltaMessage];
}

function toDeltaPart(chunk: DeltaChunk): UIPart {
  if (chunk.kind === "thinking") {
    return {
      type: "thinking",
      thinking: chunk.text,
    };
  }
  return {
    type: "text",
    text: chunk.text,
  };
}

/**
 * Determines if a thread is actively working based on its status
 */
function isThreadWorking(status: ThreadStatus): boolean {
  const workingStatuses: ThreadStatus[] = [
    "queued",
    "queued-tasks-concurrency",
    "queued-sandbox-creation-rate-limit",
    "queued-agent-rate-limit",
    "booting",
    "working",
    "stopping",
    "checkpointing",
  ];
  return workingStatuses.includes(status);
}
