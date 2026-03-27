import { useMemo, useRef } from "react";
import type { AIAgent } from "@terragon/agent/types";
import type { DBMessage, UIMessage, UIUserMessage } from "@terragon/shared";
import type {
  UIAgentMessage,
  UIToolPart,
  UICompletedToolPart,
  UIPart,
  UIGitDiffPart,
  ThreadStatus,
} from "@terragon/shared";
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

  return useMemo(() => {
    const previous = cacheRef.current;
    const nextState = buildIncrementalUIMessages({
      previous,
      dbMessages,
      agent,
      threadStatus,
      cacheKey,
    });
    cacheRef.current = nextState;

    // If there are accumulated deltas, append a synthetic agent message
    if (deltas && deltas.size > 0) {
      return appendDeltaMessages(nextState.messages, agent, deltas);
    }

    return nextState.messages;
  }, [agent, cacheKey, dbMessages, threadStatus, deltas]);
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
  const toolPartsById: Record<string, UIToolPart<string, any>> = {};

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

  function pushPart(parts: UIPart[], newPart: UIPart) {
    if (newPart.type === "text" && newPart.text.trim() === "") {
      return;
    }
    parts.push(newPart);
  }

  function pushToolPart(parts: UIPart[], toolPart: UIToolPart<string, any>) {
    if (
      toolPart.name === "TodoWrite" &&
      parts.length > 0 &&
      parts[parts.length - 1]?.type === "tool" &&
      (parts[parts.length - 1] as UIToolPart<string, any>).name === "TodoWrite"
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
            pushPart(found.parts, part);
          }
        }
      } else {
        currentAgentMessage = getOrCreateAgentMessage();
        if (currentAgentMessageStartDbIndex === -1) {
          currentAgentMessageStartDbIndex = dbIndex;
        }
        for (const part of dbMessage.parts) {
          // Merge consecutive text parts into one (e.g. ACP streams word-by-word)
          if (part.type === "text") {
            const lastPart =
              currentAgentMessage.parts[currentAgentMessage.parts.length - 1];
            if (lastPart && lastPart.type === "text") {
              lastPart.text += part.text;
              continue;
            }
          }
          // Merge consecutive thinking parts into one (same ACP streaming pattern)
          if (part.type === "thinking") {
            const lastPart =
              currentAgentMessage.parts[currentAgentMessage.parts.length - 1];
            if (lastPart && lastPart.type === "thinking") {
              lastPart.thinking += part.thinking;
              continue;
            }
          }
          pushPart(currentAgentMessage.parts, part);
        }
      }
    } else if (dbMessage.type === "tool-call") {
      clearCurrentUserMessage(dbIndex - 1);
      const newToolPart: UIToolPart<string, any> = {
        type: "tool",
        id: dbMessage.id,
        agent,
        name: dbMessage.name,
        parameters: dbMessage.parameters,
        status: "pending",
        parts: [],
      };
      // Handle tool calls with parent_tool_use_id (nested inside another tool)
      if (dbMessage.parent_tool_use_id) {
        const found = toolPartsById[dbMessage.parent_tool_use_id];
        if (found) {
          pushToolPart(found.parts, newToolPart);
        }
      } else {
        currentAgentMessage = getOrCreateAgentMessage();
        if (currentAgentMessageStartDbIndex === -1) {
          currentAgentMessageStartDbIndex = dbIndex;
        }
        pushToolPart(currentAgentMessage.parts, newToolPart);
      }
      toolPartsById[dbMessage.id] = newToolPart;
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
  // Sort by partIndex so text parts render in order
  const sorted = Array.from(deltas.entries()).sort((a, b) => {
    const aIdx = parseInt(a[0].split(":")[1]!, 10);
    const bIdx = parseInt(b[0].split(":")[1]!, 10);
    return aIdx - bIdx;
  });

  const parts: UIPart[] = sorted.map(([, chunk]) => toDeltaPart(chunk));

  if (parts.length === 0) return messages;

  const deltaMessage: UIAgentMessage = {
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
