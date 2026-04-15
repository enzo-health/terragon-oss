import { Anthropic } from "@anthropic-ai/sdk";
import { ClaudeMessage } from "@terragon/daemon/shared";
import {
  DBAgentMessagePart,
  DBAudioPart,
  DBDiffPart,
  DBImagePart,
  DBMessage,
  DBPlanPart,
  DBResourceLinkPart,
  DBServerToolUsePart,
  DBTerminalPart,
  DBThinkingPart,
  DBToolCall,
  DBWebSearchResultEntry,
  DBWebSearchResultPart,
} from "@terragon/shared";

/**
 * Converts a ClaudeMessage to one or more DBMessages
 * @param claudeMessage The ClaudeMessage to convert
 * @returns Array of DBMessages (could be multiple if message contains both text and tool calls)
 */
export function toDBMessage(claudeMessage: ClaudeMessage): DBMessage[] {
  switch (claudeMessage.type) {
    case "user":
      return convertUserMessage(
        claudeMessage.message,
        claudeMessage.parent_tool_use_id,
      );
    case "assistant":
      return convertAssistantMessage(
        claudeMessage.message,
        claudeMessage.parent_tool_use_id,
      );
    case "custom-stop":
      return [{ type: "stop" }];
    case "custom-error":
      return [
        {
          type: "error",
          error_type: "agent-generic-error",
          error_info: claudeMessage.error_info ?? "",
          timestamp: new Date().toISOString(),
        },
      ];

    case "result":
      return [
        {
          type: "meta",
          subtype:
            claudeMessage.subtype === "success"
              ? "result-success"
              : claudeMessage.subtype === "error_max_turns"
                ? "result-error-max-turns"
                : "result-error",
          cost_usd:
            "total_cost_usd" in claudeMessage
              ? claudeMessage.total_cost_usd
              : 0,
          duration_ms: claudeMessage.duration_ms,
          duration_api_ms:
            "duration_api_ms" in claudeMessage
              ? claudeMessage.duration_api_ms
              : 0,
          is_error: claudeMessage.is_error,
          num_turns: claudeMessage.num_turns,
          result:
            claudeMessage.subtype === "success"
              ? claudeMessage.result
              : claudeMessage.subtype === "error_during_execution"
                ? claudeMessage.error
                : undefined,
          session_id: claudeMessage.session_id,
        },
      ];

    case "system":
      if (claudeMessage.subtype === "init") {
        return [
          {
            type: "meta" as const,
            subtype: "system-init" as const,
            session_id: claudeMessage.session_id,
            tools: claudeMessage.tools,
            mcp_servers: claudeMessage.mcp_servers,
          },
        ];
      }
      return [];

    // ACP sessionUpdate events — previously dropped at this default branch.
    // The daemon's AcpToolCallTracker emits a fresh `acp-tool-call` snapshot
    // on every tool_call and tool_call_update, so we only persist the final
    // (terminal) snapshot to avoid duplicate DB entries. Intermediate updates
    // still reach live viewers through the broadcast layer. See Wave 2 PR D.
    case "acp-tool-call":
      return convertAcpToolCall(claudeMessage);
    case "acp-plan":
      return convertAcpPlan(claudeMessage);
    case "codex-plan":
      return convertCodexPlan(claudeMessage);
    case "acp-image":
      return convertAcpImage(claudeMessage);
    case "acp-audio":
      return convertAcpAudio(claudeMessage);
    case "acp-resource-link":
      return convertAcpResourceLink(claudeMessage);
    case "acp-terminal":
      return convertAcpTerminal(claudeMessage);
    case "acp-diff":
      return convertAcpDiff(claudeMessage);

    default: {
      // eslint-disable-next-line no-console
      console.warn(
        "[toDBMessage] Unknown ClaudeMessage type:",
        (claudeMessage as { type?: string }).type,
      );
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// ACP converters — each maps a ClaudeMessage acp-* variant to one or more
// DBMessage entries so ACP sessions are fully represented in chat history
// (not just in the ephemeral broadcast stream).
// ---------------------------------------------------------------------------

function convertAcpToolCall(
  msg: Extract<ClaudeMessage, { type: "acp-tool-call" }>,
): DBMessage[] {
  // Persist only terminal snapshots. "pending" and "in_progress" states are
  // streamed live but would produce duplicate DB rows for the same toolCallId
  // since the ACP adapter emits a fresh snapshot on every update.
  if (msg.status !== "completed" && msg.status !== "failed") {
    return [];
  }
  const dbToolCall: DBToolCall = {
    type: "tool-call",
    id: msg.toolCallId,
    name: msg.title || msg.kind,
    parameters: {
      kind: msg.kind,
      title: msg.title,
      locations: msg.locations,
      rawInput: msg.rawInput,
      rawOutput: msg.rawOutput,
    },
    parent_tool_use_id: null,
    status: msg.status,
    ...(msg.startedAt ? { startedAt: msg.startedAt } : {}),
    ...(msg.completedAt ? { completedAt: msg.completedAt } : {}),
    ...(msg.progressChunks.length > 0
      ? { progressChunks: msg.progressChunks }
      : {}),
  };
  return [dbToolCall];
}

function convertAcpPlan(
  msg: Extract<ClaudeMessage, { type: "acp-plan" }>,
): DBMessage[] {
  return planMessageFromEntries(msg.entries);
}

function convertCodexPlan(
  msg: Extract<ClaudeMessage, { type: "codex-plan" }>,
): DBMessage[] {
  return planMessageFromEntries(msg.entries);
}

function planMessageFromEntries(
  entries: Array<{
    id?: string;
    content: string;
    priority: "high" | "medium" | "low";
    status: "pending" | "in_progress" | "completed";
  }>,
): DBMessage[] {
  const plan: DBPlanPart = {
    type: "plan",
    entries: entries.map((e) => ({
      ...(e.id ? { id: e.id } : {}),
      content: e.content,
      priority: e.priority,
      // DBPlanPart allows "failed"; ACP/Codex only emit the three above.
      status: e.status,
    })),
  };
  return [{ type: "agent", parent_tool_use_id: null, parts: [plan] }];
}

function convertAcpImage(
  msg: Extract<ClaudeMessage, { type: "acp-image" }>,
): DBMessage[] {
  const imageUrl =
    msg.uri ?? (msg.data ? `data:${msg.mimeType};base64,${msg.data}` : null);
  if (!imageUrl) return [];
  const image: DBImagePart = {
    type: "image",
    mime_type: msg.mimeType,
    image_url: imageUrl,
  };
  return [{ type: "agent", parent_tool_use_id: null, parts: [image] }];
}

function convertAcpAudio(
  msg: Extract<ClaudeMessage, { type: "acp-audio" }>,
): DBMessage[] {
  const audio: DBAudioPart = {
    type: "audio",
    mimeType: msg.mimeType,
    ...(msg.data ? { data: msg.data } : {}),
    ...(msg.uri ? { uri: msg.uri } : {}),
  };
  return [{ type: "agent", parent_tool_use_id: null, parts: [audio] }];
}

function convertAcpResourceLink(
  msg: Extract<ClaudeMessage, { type: "acp-resource-link" }>,
): DBMessage[] {
  const link: DBResourceLinkPart = {
    type: "resource-link",
    uri: msg.uri,
    name: msg.name,
    ...(msg.title ? { title: msg.title } : {}),
    ...(msg.description ? { description: msg.description } : {}),
    ...(msg.mimeType ? { mimeType: msg.mimeType } : {}),
    ...(typeof msg.size === "number" ? { size: msg.size } : {}),
  };
  return [{ type: "agent", parent_tool_use_id: null, parts: [link] }];
}

function convertAcpTerminal(
  msg: Extract<ClaudeMessage, { type: "acp-terminal" }>,
): DBMessage[] {
  const terminal: DBTerminalPart = {
    type: "terminal",
    // ACP terminal events carry their own terminal id but no sandbox id.
    // Use terminalId as the sandbox key — the UI treats the pair as opaque.
    sandboxId: msg.terminalId,
    terminalId: msg.terminalId,
    chunks: msg.chunks,
  };
  return [{ type: "agent", parent_tool_use_id: null, parts: [terminal] }];
}

function convertAcpDiff(
  msg: Extract<ClaudeMessage, { type: "acp-diff" }>,
): DBMessage[] {
  const diff: DBDiffPart = {
    type: "diff",
    filePath: msg.filePath,
    newContent: msg.newContent,
    status: msg.status,
    ...(msg.oldContent !== undefined ? { oldContent: msg.oldContent } : {}),
    ...(msg.unifiedDiff !== undefined ? { unifiedDiff: msg.unifiedDiff } : {}),
  };
  return [{ type: "agent", parent_tool_use_id: null, parts: [diff] }];
}

function convertUserMessage(
  message: Anthropic.MessageParam,
  parent_tool_use_id: string | null,
): DBMessage[] {
  if (message.role !== "user") {
    return [];
  }
  const dbMessages: DBMessage[] = [];
  // Handle both string content and content array
  if (typeof message.content === "string") {
    const match = message.content.match(
      /^<local-command-stdout>(.*?)<\/local-command-stdout>$/s,
    );
    if (match && match[1]) {
      return [
        {
          type: "agent",
          parent_tool_use_id,
          parts: [{ type: "text", text: `\`\`\`\n${match[1]}\n\`\`\`` }],
        },
      ];
    }
    return [
      {
        type: "user",
        model: null,
        parts: [
          {
            type: "text",
            text: message.content,
          },
        ],
      },
    ];
  }

  if (Array.isArray(message.content)) {
    // Check if this message contains tool results
    const hasToolResults = message.content.some(
      (part) => part.type === "tool_result",
    );

    // Collect text parts for the user message
    const textParts = message.content
      .filter((part): part is Anthropic.TextBlockParam => part.type === "text")
      .map((part) => ({
        type: "text" as const,
        text: part.text,
      }));

    // Filter out user messages with parent_tool_use_id that only contain text
    // These are Task tool prompts that shouldn't be displayed as user messages
    if (textParts.length > 0 && !(parent_tool_use_id && !hasToolResults)) {
      dbMessages.push({
        type: "user",
        model: null,
        parts: textParts,
      });
    }

    // Extract tool results
    message.content
      .filter(
        (part): part is Anthropic.ToolResultBlockParam =>
          part.type === "tool_result",
      )
      .forEach((toolResult) => {
        if (typeof toolResult.content === "string") {
          dbMessages.push({
            type: "tool-result",
            id: toolResult.tool_use_id,
            is_error: toolResult.is_error ?? null,
            result: toolResult.content,
            parent_tool_use_id,
          });
        } else if (Array.isArray(toolResult.content)) {
          const content = toolResult.content.map((part) => {
            if (part.type === "image") {
              return { type: "image", source: "..." };
            }
            return part;
          });
          dbMessages.push({
            type: "tool-result",
            id: toolResult.tool_use_id,
            is_error: toolResult.is_error ?? null,
            result: JSON.stringify(content),
            parent_tool_use_id,
          });
        }
      });
  }

  return dbMessages;
}

function convertAssistantMessage(
  message: Anthropic.MessageParam,
  parent_tool_use_id: string | null,
): DBMessage[] {
  if (message.role !== "assistant") {
    return [];
  }

  const dbMessages: DBMessage[] = [];
  // Handle both string content and content array
  if (typeof message.content === "string") {
    dbMessages.push({
      type: "agent",
      parent_tool_use_id,
      parts: [
        {
          type: "text",
          text: message.content,
        },
      ],
    });
  } else if (Array.isArray(message.content)) {
    // Collect inline narration parts (text, thinking, and server-side tools
    // whose result rides in the same message content array).
    const agentParts: DBAgentMessagePart[] = [];
    for (const part of message.content) {
      const partWithType = part as { type?: string };
      if (partWithType.type === "text") {
        agentParts.push({
          type: "text" as const,
          text: (part as Anthropic.TextBlockParam).text,
        });
        continue;
      }
      if (partWithType.type === "thinking") {
        const thinkingPart = part as Anthropic.ThinkingBlockParam;
        const thinking: DBThinkingPart = {
          type: "thinking",
          thinking: thinkingPart.thinking,
        };
        // Anthropic SDK types may not expose `signature` yet; preserve when
        // present so multi-turn continuations retain thinking context.
        const signature = (thinkingPart as { signature?: string }).signature;
        if (typeof signature === "string") {
          thinking.signature = signature;
        }
        agentParts.push(thinking);
        continue;
      }
      if (partWithType.type === "server_tool_use") {
        const stu = part as {
          id: string;
          name: string;
          input?: Record<string, unknown>;
        };
        const serverToolUse: DBServerToolUsePart = {
          type: "server-tool-use",
          id: stu.id,
          name: stu.name,
          input: stu.input ?? {},
        };
        agentParts.push(serverToolUse);
        continue;
      }
      if (partWithType.type === "web_search_tool_result") {
        const wst = part as {
          tool_use_id: string;
          content:
            | Array<{
                type?: string;
                url?: string;
                title?: string;
                page_age?: string;
                encrypted_content?: string;
              }>
            | { type?: string; error_code?: string };
        };
        const result: DBWebSearchResultPart = {
          type: "web-search-result",
          toolUseId: wst.tool_use_id,
        };
        if (Array.isArray(wst.content)) {
          result.results = wst.content
            .filter((r) => r.type === "web_search_result" && r.url && r.title)
            .map(
              (r): DBWebSearchResultEntry => ({
                url: r.url!,
                title: r.title!,
                ...(r.page_age ? { pageAge: r.page_age } : {}),
                ...(r.encrypted_content
                  ? { encryptedContent: r.encrypted_content }
                  : {}),
              }),
            );
        } else if (wst.content && typeof wst.content === "object") {
          if (typeof wst.content.error_code === "string") {
            result.errorCode = wst.content.error_code;
          }
        }
        agentParts.push(result);
        continue;
      }
    }
    if (agentParts.length > 0) {
      dbMessages.push({
        type: "agent",
        parent_tool_use_id,
        parts: agentParts,
      });
    }

    // Extract tool calls (client-executed tools — server_tool_use is handled
    // above and goes into the agent message's inline narration).
    message.content
      .filter(
        (part): part is Anthropic.ToolUseBlockParam => part.type === "tool_use",
      )
      .forEach((toolUse) => {
        dbMessages.push({
          type: "tool-call",
          id: toolUse.id,
          name: toolUse.name,
          parameters: toolUse.input || {},
          parent_tool_use_id,
        });
      });
  }

  return dbMessages;
}
