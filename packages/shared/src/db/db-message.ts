import type { AIModel } from "@terragon/agent/types";
import type { GitDiffStats } from "./types";

export type DBMessage =
  | DBUserMessage
  | DBAgentMessage
  | DBSystemMessage
  | DBToolCall
  | DBToolResult
  | DBGitDiffMessage
  | DBStopMessage
  | DBErrorMessage
  | DBMetaMessage
  | DBThreadContextMessage
  | DBThreadContextResultMessage
  | DBDelegationMessage;

/**
 * Schema version — bump when the DBMessage union gains new variants or
 * existing shapes change in a backward-incompatible way.
 */
export const DB_MESSAGE_SCHEMA_VERSION = 2;

export type DBUserMessage = {
  type: "user";
  model: AIModel | null;
  parts: (
    | DBTextPart
    | DBImagePart
    | DBRichTextPart
    | DBPdfPart
    | DBTextFilePart
  )[];
  timestamp?: string;
  permissionMode?: "allowAll" | "plan";
};

export type DBUserMessageWithModel = DBUserMessage & {
  model: AIModel;
};

export type DBSystemMessage = {
  type: "system";
  message_type:
    | "cancel-schedule"
    | "fix-github-checks"
    | "retry-git-commit-and-push"
    | "generic-retry"
    | "invalid-token-retry"
    | "clear-context"
    | "compact-result"
    | "sdlc-error-retry"
    | "follow-up-retry-failed";
  parts: DBTextPart[];
  timestamp?: string;
  model?: AIModel | null;
};

export type DBThreadContextMessage = {
  type: "thread-context";
  threadId: string;
  threadChatId: string;
  threadChatHistory: string;
  taskDescription: string;
};

export type DBThreadContextResultMessage = {
  type: "thread-context-result";
  summary: string;
};

export type DBRichTextPart = {
  type: "rich-text";
  nodes: DBRichTextNode[];
};

export type DBRichTextNode =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "mention";
      text: string;
    }
  | {
      type: "link";
      text: string;
    };

export type DBTextPart = {
  type: "text";
  text: string;
};

export type DBImagePart = {
  type: "image";
  mime_type: string;
  image_url: string;
};

type DBPdfPart = {
  type: "pdf";
  mime_type: string;
  pdf_url: string;
  filename?: string;
};

type DBTextFilePart = {
  type: "text-file";
  mime_type: string;
  file_url: string;
  filename?: string;
};

export type DBThinkingPart = {
  type: "thinking";
  thinking: string;
  /**
   * Encrypted signature from the Anthropic API that must be resubmitted
   * when continuing a multi-turn conversation that used extended thinking.
   * If we drop this, continuation requests lose their thinking context.
   */
  signature?: string;
};

/**
 * A `server_tool_use` block — the Anthropic API's own server executed a tool
 * (e.g. `web_search`, `code_execution`) without a round-trip to the agent.
 * The accompanying result arrives as a `DBWebSearchResultPart` (or similar)
 * later in the same message's content array.
 *
 * Distinct from `DBToolCall` which represents client-side tools that require
 * the agent to round-trip for execution.
 */
export type DBServerToolUsePart = {
  type: "server-tool-use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/** Single result row in a web_search_tool_result. */
export type DBWebSearchResultEntry = {
  url: string;
  title: string;
  pageAge?: string;
  encryptedContent?: string;
};

/**
 * Result of a server-side `web_search` tool invocation. Pairs with a prior
 * `DBServerToolUsePart` via `toolUseId`.
 *
 * Either `results` (success) or `errorCode` (failure) is set. Both-missing
 * is invalid but tolerated for forward compatibility with unknown shapes.
 */
export type DBWebSearchResultPart = {
  type: "web-search-result";
  toolUseId: string;
  results?: DBWebSearchResultEntry[];
  errorCode?: string;
};

export type DBToolCall = {
  type: "tool-call";
  id: string;
  name: string;
  parameters: Record<string, any>;
  parent_tool_use_id: string | null;
  // Lifecycle fields — optional so existing callers remain valid
  startedAt?: string;
  completedAt?: string;
  status?: "started" | "in_progress" | "completed" | "failed";
  progressChunks?: Array<{ seq: number; text: string }>;
  /** Structured MCP tool metadata, set when name matches `mcp__<server>__<tool>`. */
  mcpMetadata?: { server: string; tool: string };
};

type DBToolResult = {
  type: "tool-result";
  id: string;
  is_error: boolean | null;
  parent_tool_use_id: string | null;
  result: string;
};

export type DBAudioPart = {
  type: "audio";
  mimeType: string;
  data?: string; // base64-encoded audio
  uri?: string; // alternative: URI reference
};

export type DBResourceLinkPart = {
  type: "resource-link";
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
};

export type DBTerminalPart = {
  type: "terminal";
  sandboxId: string;
  terminalId: string;
  chunks: Array<{
    streamSeq: number;
    kind: "stdout" | "stderr" | "interaction";
    text: string;
  }>;
};

export type DBDiffPart = {
  type: "diff";
  filePath: string;
  oldContent?: string;
  newContent: string;
  unifiedDiff?: string;
  status: "pending" | "applied" | "rejected";
};

export type DBPlanPart = {
  type: "plan";
  entries: Array<{
    id?: string;
    content: string;
    priority: "high" | "medium" | "low";
    status: "pending" | "in_progress" | "completed" | "failed";
  }>;
};

/**
 * Represents a Codex `autoApprovalReview` item — an automated risk assessment
 * that decides whether a proposed action (e.g. a file change) should be
 * approved without human intervention.
 *
 * Field mapping verified against fixtures at:
 *   packages/daemon/src/__fixtures__/codex/item-auto-approval-review-started.json
 *   packages/daemon/src/__fixtures__/codex/item-auto-approval-review-completed.json
 */
export type DBAutoApprovalReviewPart = {
  type: "auto-approval-review";
  reviewId: string;
  targetItemId: string;
  riskLevel: "low" | "medium" | "high";
  action: string;
  decision?: "approved" | "denied";
  rationale?: string;
  status: "pending" | "approved" | "denied";
};

/** Union of all part types that can appear in a DBAgentMessage. */
export type DBAgentMessagePart =
  | DBTextPart
  | DBThinkingPart
  | DBTerminalPart
  | DBDiffPart
  | DBResourceLinkPart
  | DBAudioPart
  | DBAutoApprovalReviewPart
  | DBImagePart
  | DBPlanPart
  | DBServerToolUsePart
  | DBWebSearchResultPart;

type DBAgentMessage = {
  type: "agent";
  parent_tool_use_id: string | null;
  parts: DBAgentMessagePart[];
};

type DBGitDiffMessage = {
  type: "git-diff";
  diff: string;
  diffStats?: GitDiffStats | null;
  timestamp?: string;
  description?: string;
};

type DBStopMessage = {
  type: "stop";
};

type DBErrorMessage = {
  type: "error";
  error_type?: string; // Can be ThreadErrorType or any string
  error_info?: string;
  timestamp?: string;
};

type DBMetaMessage = DBSystemMetaMessage | DBResultMetaMessage;

type DBSystemMetaMessage =
  | {
      type: "meta";
      subtype: "system-init";
      session_id: string;
      tools: string[];
      mcp_servers: {
        name: string;
        status: string;
      }[];
    }
  | {
      type: "meta";
      subtype: "system-metadata";
      content: string;
    };

export type DBResultMetaMessage = {
  type: "meta";
  subtype: "result-success" | "result-error-max-turns" | "result-error";
  cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  result?: string;
  session_id: string;
};

/**
 * Represents a Codex collabAgentToolCall item persisted as a chat message.
 *
 * Field mapping verified against fixture at:
 *   packages/daemon/src/__fixtures__/codex/collab-agent-tool-call-completed.json
 *
 * Fixture fields: id → delegationId, type (collabAgentToolCall) → implicit via message type:
 *   "delegation", senderThreadId, receiverThreadIds, prompt, model → delegatedModel,
 *   reasoningEffort, agentsStates, tool, status.
 * The fixture also has threadId + turnId at the params level (not stored here).
 */
export type DBDelegationMessage = {
  type: "delegation";
  model: AIModel | null;
  delegationId: string; // the item id from Codex
  tool: "spawn" | "message" | "kill";
  status: "initiated" | "running" | "completed" | "failed";
  senderThreadId: string;
  receiverThreadIds: string[];
  prompt: string;
  delegatedModel: string; // the sub-agent's model
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  agentsStates: Record<
    string,
    "initiated" | "running" | "completed" | "failed"
  >;
  timestamp?: string;
};
