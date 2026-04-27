import type { AIAgent } from "@terragon/agent/types";
import type {
  DBAgentMessagePart,
  DBMessage,
  ThreadStatus,
  UIAgentMessage,
  UICompletedToolPart,
  UIGitDiffPart,
  UIMessage,
  UIPart,
  UIStructuredPlanPart,
  UIToolPart,
  UIUserMessage,
} from "@terragon/shared";
import type { UIPartExtended } from "./ui-parts-extended";

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
 * This pure function is now a read-only legacy snapshot adapter. Active task
 * rendering feeds the result into `ThreadViewModel`, where AG-UI and optimistic
 * events are folded on top.
 *
 * @param dbMessages - The messages from the database
 * @param threadStatus - Optional thread status to determine if pending tools should be marked complete
 */
export function toUIMessages({
  dbMessages,
  agent,
  threadStatus,
  skipSeededAssistantText = false,
}: {
  dbMessages: DBMessage[];
  agent: AIAgent;
  threadStatus?: ThreadStatus | null;
  /**
   * Suppresses top-level assistant text parts in bootstrap seeds.
   *
   * This is used when canonical AG-UI replay is expected to stream the same
   * text immediately after mount; skipping text in the seed avoids
   * seed+replay duplicate assistant bubbles while preserving non-text parts
   * (tool cards, plans, rich parts) for first paint.
   */
  skipSeededAssistantText?: boolean;
}): UIMessage[] {
  const uiMessages: UIMessage[] = [];
  let currentAgentMessage: UIAgentMessage | null = null;
  let currentUserMessage: UIUserMessage | null = null;

  // Map to store tool parts by their ID for efficient lookup
  const toolPartsById: Record<string, InternalToolPart> = {};

  function markPendingToolsAsCompleted() {
    for (const toolPart of Object.values(toolPartsById)) {
      if (toolPart.status === "pending") {
        (toolPart as any).status = "completed";
        (toolPart as any).result = "[Tool execution was interrupted]";
      }
    }
  }

  function getOrCreateAgentMessage(): UIAgentMessage {
    if (currentAgentMessage) {
      return currentAgentMessage;
    }
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
    currentUserMessage = {
      id: `user-${uiMessages.length}`,
      role: "user",
      parts: [],
    };
    return currentUserMessage;
  }

  function clearCurrentUserMessage() {
    if (currentUserMessage) {
      uiMessages.push(currentUserMessage);
      currentUserMessage = null;
    }
  }

  function clearCurrentAgentMessage() {
    if (currentAgentMessage) {
      uiMessages.push(currentAgentMessage);
      currentAgentMessage = null;
    }
  }

  function pushPart(parts: UIPart[], newPart: UIPartExtended) {
    if (newPart.type === "text" && newPart.text.trim() === "") {
      return;
    }
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
      parts[parts.length - 1] = toolPart;
    } else {
      pushPart(parts, toolPart);
    }
  }

  for (const [dbIndex, dbMessage] of dbMessages.entries()) {
    if (dbMessage.type === "meta" && dbMessage.subtype === "result-success") {
      if (currentAgentMessage && dbMessage.duration_ms > 0) {
        currentAgentMessage.meta = {
          cost_usd: dbMessage.cost_usd,
          duration_ms: dbMessage.duration_ms,
          num_turns: dbMessage.num_turns,
        };
      }
      clearCurrentAgentMessage();
      clearCurrentUserMessage();
      continue;
    }
    if (dbMessage.type === "user") {
      markPendingToolsAsCompleted();
      clearCurrentAgentMessage();
      const userMessage = getOrCreateUserMessage();
      for (const part of dbMessage.parts) {
        pushPart(userMessage.parts, part);
      }
      userMessage.timestamp = dbMessage.timestamp;
      userMessage.model = dbMessage.model;
    } else if (dbMessage.type === "system") {
      clearCurrentAgentMessage();
      clearCurrentUserMessage();
      uiMessages.push({
        id: `system-${dbIndex}`,
        role: "system",
        message_type: dbMessage.message_type,
        parts: dbMessage.parts,
      });
    } else if (dbMessage.type === "agent") {
      clearCurrentUserMessage();
      const filteredParts =
        skipSeededAssistantText && dbMessage.parent_tool_use_id === null
          ? dbMessage.parts.filter((part) => part.type !== "text")
          : dbMessage.parts;
      if (filteredParts.length === 0) {
        continue;
      }
      if (dbMessage.parent_tool_use_id) {
        const found = toolPartsById[dbMessage.parent_tool_use_id];
        if (found) {
          for (const part of filteredParts) {
            const uiPart = dbAgentPartToUIPart(part);
            if (uiPart) pushPart(found.parts, uiPart);
          }
        }
      } else {
        currentAgentMessage = getOrCreateAgentMessage();
        for (const part of filteredParts) {
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
    } else if (dbMessage.type === "delegation") {
      clearCurrentUserMessage();
      currentAgentMessage = getOrCreateAgentMessage();
      pushPart(currentAgentMessage.parts, dbMessage);
    } else if (dbMessage.type === "tool-call") {
      clearCurrentUserMessage();
      const existingToolPart = toolPartsById[dbMessage.id];
      const newToolPart: InternalToolPart = {
        type: "tool",
        id: dbMessage.id,
        agent,
        name: dbMessage.name,
        parameters: dbMessage.parameters,
        status: "pending",
        parts: [],
        ...(dbMessage.progressChunks
          ? { progressChunks: dbMessage.progressChunks }
          : {}),
        ...(dbMessage.mcpMetadata
          ? { mcpMetadata: dbMessage.mcpMetadata }
          : {}),
        ...(dbMessage.status ? { toolStatus: dbMessage.status } : {}),
      };
      if (dbMessage.parent_tool_use_id) {
        const found = toolPartsById[dbMessage.parent_tool_use_id];
        if (found) {
          replaceOrPushToolPart(found.parts, newToolPart);
        }
      } else {
        currentAgentMessage = getOrCreateAgentMessage();
        replaceOrPushToolPart(currentAgentMessage.parts, newToolPart);
      }
      if (!existingToolPart) {
        toolPartsById[dbMessage.id] = newToolPart;
      }
    } else if (dbMessage.type === "tool-result") {
      const found = toolPartsById[dbMessage.id];
      if (found) {
        found.status = dbMessage.is_error ? "error" : "completed";
        (found as UICompletedToolPart<string, any>).result = dbMessage.result;
      }
    } else if (dbMessage.type === "git-diff") {
      markPendingToolsAsCompleted();
      clearCurrentAgentMessage();
      clearCurrentUserMessage();

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
    } else if (dbMessage.type === "stop") {
      markPendingToolsAsCompleted();
      clearCurrentAgentMessage();
      clearCurrentUserMessage();
      uiMessages.push({
        id: `stop-${dbIndex}`,
        role: "system",
        message_type: "stop",
        parts: [{ type: "stop" }],
      });
    } else if (dbMessage.type === "error") {
      markPendingToolsAsCompleted();
      clearCurrentAgentMessage();
      clearCurrentUserMessage();
      // Error messages are not rendered in the UI transcript.
    } else if (
      dbMessage.type === "meta" &&
      dbMessage.subtype === "result-error-max-turns"
    ) {
      markPendingToolsAsCompleted();
      // Meta messages are ignored in UI
    }
  }
  clearCurrentUserMessage();
  clearCurrentAgentMessage();

  if (threadStatus && !isThreadWorking(threadStatus)) {
    markPendingToolsAsCompleted();
  }

  return uiMessages;
}

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
