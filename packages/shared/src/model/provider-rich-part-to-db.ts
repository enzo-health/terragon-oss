import type { ProviderRichPart } from "@terragon/agent/canonical-events";
import type {
  DBAgentMessagePart,
  DBAudioPart,
  DBAutoApprovalReviewPart,
  DBDiffPart,
  DBErrorPart,
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
} from "../db/db-message";

type AssistantNarrationPart = Extract<
  ProviderRichPart,
  { richKind: "assistant-narration" }
>["payload"]["parts"][number];

function narrationPartToDbAgentPart(
  part: AssistantNarrationPart,
): DBAgentMessagePart {
  switch (part.kind) {
    case "text":
      return { type: "text", text: part.text };
    case "thinking": {
      const thinking: DBThinkingPart = {
        type: "thinking",
        thinking: part.thinking,
      };
      if (part.signature !== undefined) {
        thinking.signature = part.signature;
      }
      return thinking;
    }
    case "server-tool-use": {
      const serverToolUse: DBServerToolUsePart = {
        type: "server-tool-use",
        id: part.id,
        name: part.name,
        input: part.input,
      };
      return serverToolUse;
    }
    case "web-search-result": {
      const result: DBWebSearchResultPart = {
        type: "web-search-result",
        toolUseId: part.toolUseId,
      };
      if (Array.isArray(part.content)) {
        result.results = part.content
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
      } else if (typeof part.content.error_code === "string") {
        result.errorCode = part.content.error_code;
      }
      return result;
    }
    case "document": {
      const title =
        typeof part.title === "string" && part.title.length > 0
          ? part.title
          : "Document";
      if (part.source?.type === "url" && part.source.url) {
        const link: DBResourceLinkPart = {
          type: "resource-link",
          uri: part.source.url,
          name: title,
          title,
          ...(part.source.media_type
            ? { mimeType: part.source.media_type }
            : {}),
          ...(part.context ? { description: part.context } : {}),
        };
        return link;
      }
      const label =
        part.source?.type === "file" && part.source.file_id
          ? `${title} (file:${part.source.file_id})`
          : title;
      return {
        type: "text",
        text: `**${label}**${part.context ? `\n\n${part.context}` : ""}`,
      };
    }
    default: {
      const _exhaustiveCheck: never = part;
      return _exhaustiveCheck;
    }
  }
}

export function providerRichPartToDbMessages(
  part: ProviderRichPart,
): DBMessage[] {
  switch (part.richKind) {
    case "acp-plan":
    case "codex-plan":
      return planMessageFromEntries(part.payload.entries);

    case "acp-diff": {
      const diff: DBDiffPart = {
        type: "diff",
        filePath: part.payload.filePath,
        newContent: part.payload.newContent,
        status: part.payload.status,
        ...(part.payload.oldContent !== undefined
          ? { oldContent: part.payload.oldContent }
          : {}),
        ...(part.payload.unifiedDiff !== undefined
          ? { unifiedDiff: part.payload.unifiedDiff }
          : {}),
      };
      return [{ type: "agent", parent_tool_use_id: null, parts: [diff] }];
    }

    case "codex-diff": {
      const diff: DBDiffPart = {
        type: "diff",
        filePath: "",
        newContent: "",
        unifiedDiff: part.payload.diff,
        status: "pending",
      };
      return [{ type: "agent", parent_tool_use_id: null, parts: [diff] }];
    }

    case "codex-error": {
      const error: DBErrorPart = {
        type: "error",
        message: part.payload.message,
        source: "codex",
      };
      return [{ type: "agent", parent_tool_use_id: null, parts: [error] }];
    }

    case "acp-terminal": {
      const terminal: DBTerminalPart = {
        type: "terminal",
        sandboxId: part.payload.terminalId,
        terminalId: part.payload.terminalId,
        chunks: part.payload.chunks,
      };
      return [{ type: "agent", parent_tool_use_id: null, parts: [terminal] }];
    }

    case "acp-image": {
      const imageUrl =
        part.payload.uri ??
        (part.payload.data
          ? `data:${part.payload.mimeType};base64,${part.payload.data}`
          : null);
      if (!imageUrl) return [];
      const image: DBImagePart = {
        type: "image",
        mime_type: part.payload.mimeType,
        image_url: imageUrl,
      };
      return [{ type: "agent", parent_tool_use_id: null, parts: [image] }];
    }

    case "acp-audio": {
      const audio: DBAudioPart = {
        type: "audio",
        mimeType: part.payload.mimeType,
        ...(part.payload.data !== undefined ? { data: part.payload.data } : {}),
        ...(part.payload.uri !== undefined ? { uri: part.payload.uri } : {}),
      };
      return [{ type: "agent", parent_tool_use_id: null, parts: [audio] }];
    }

    case "acp-resource-link": {
      const link: DBResourceLinkPart = {
        type: "resource-link",
        uri: part.payload.uri,
        name: part.payload.name,
        ...(part.payload.title !== undefined
          ? { title: part.payload.title }
          : {}),
        ...(part.payload.description !== undefined
          ? { description: part.payload.description }
          : {}),
        ...(part.payload.mimeType !== undefined
          ? { mimeType: part.payload.mimeType }
          : {}),
        ...(typeof part.payload.size === "number"
          ? { size: part.payload.size }
          : {}),
      };
      return [{ type: "agent", parent_tool_use_id: null, parts: [link] }];
    }

    case "codex-auto-approval-review": {
      const review: DBAutoApprovalReviewPart = {
        type: "auto-approval-review",
        reviewId: part.payload.reviewId,
        targetItemId: part.payload.targetItemId,
        riskLevel: part.payload.riskLevel,
        action: part.payload.action,
        status: part.payload.status,
        ...(part.payload.decision !== undefined
          ? { decision: part.payload.decision }
          : {}),
        ...(part.payload.rationale !== undefined
          ? { rationale: part.payload.rationale }
          : {}),
      };
      return [{ type: "agent", parent_tool_use_id: null, parts: [review] }];
    }

    case "acp-tool-call": {
      if (
        part.payload.status !== "completed" &&
        part.payload.status !== "failed"
      ) {
        return [];
      }
      const toolCall: DBToolCall = {
        type: "tool-call",
        id: part.payload.toolCallId,
        name: part.payload.title || part.payload.kind,
        parameters: {
          kind: part.payload.kind,
          title: part.payload.title,
          locations: part.payload.locations,
          rawInput: part.payload.rawInput,
          rawOutput: part.payload.rawOutput,
        },
        parent_tool_use_id: null,
        status: part.payload.status,
        ...(part.payload.startedAt
          ? { startedAt: part.payload.startedAt }
          : {}),
        ...(part.payload.completedAt
          ? { completedAt: part.payload.completedAt }
          : {}),
        ...(part.payload.progressChunks.length > 0
          ? { progressChunks: part.payload.progressChunks }
          : {}),
      };
      return [toolCall];
    }

    case "system-init":
      return [
        {
          type: "meta",
          subtype: "system-init",
          session_id: part.payload.session_id,
          tools: part.payload.tools,
          mcp_servers: part.payload.mcp_servers,
        },
      ];

    case "result":
      return [
        {
          type: "meta",
          subtype:
            part.payload.subtype === "success"
              ? "result-success"
              : part.payload.subtype === "error_max_turns"
                ? "result-error-max-turns"
                : "result-error",
          cost_usd: part.payload.cost_usd,
          duration_ms: part.payload.duration_ms,
          duration_api_ms: part.payload.duration_api_ms,
          is_error: part.payload.is_error,
          num_turns: part.payload.num_turns,
          result: part.payload.result,
          session_id: part.payload.session_id,
        },
      ];

    case "assistant-narration": {
      const parts = part.payload.parts.map(narrationPartToDbAgentPart);
      if (parts.length === 0) {
        return [];
      }
      return [
        {
          type: "agent",
          parent_tool_use_id: part.payload.parentToolUseId,
          parts,
        },
      ];
    }

    default: {
      const _exhaustiveCheck: never = part;
      return _exhaustiveCheck;
    }
  }
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
    entries: entries.map((entry) => ({
      ...(entry.id ? { id: entry.id } : {}),
      content: entry.content,
      priority: entry.priority,
      status: entry.status,
    })),
  };
  return [{ type: "agent", parent_tool_use_id: null, parts: [plan] }];
}
