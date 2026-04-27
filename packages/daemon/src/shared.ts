import { Anthropic } from "@anthropic-ai/sdk";
import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import { AIAgentSchema } from "@terragon/agent/types";
import * as z from "zod/v4";
import type { ThreadMetaEvent } from "./codex-app-server";

export const defaultPipePath = "/tmp/terragon-daemon.pipe";
export const defaultUnixSocketPath = "/tmp/terragon-daemon.sock";

// Increment this when you make a breaking change to the daemon.
// 1: Supports the --version flag
export const DAEMON_VERSION = "1";
export const DAEMON_EVENT_VERSION_HEADER = "X-Daemon-Version";
export const DAEMON_EVENT_CAPABILITIES_HEADER = "X-Daemon-Capabilities";
export const DAEMON_CAPABILITY_EVENT_ENVELOPE_V2 = "daemon_event_envelope_v2";

// TODO sawyer: we don't want to depend on shared so mirror the ones we need here.
export type FeatureFlags = {
  mcpPermissionPrompt?: boolean;
};

export const DaemonTransportModeSchema = z.enum([
  "legacy",
  "acp",
  "codex-app-server",
]);
export type DaemonTransportMode = z.infer<typeof DaemonTransportModeSchema>;

export const RuntimeAdapterOperationSchema = z.enum([
  "start",
  "resume",
  "stop",
  "restart",
  "retry",
  "permission-response",
  "event-normalization",
  "compact-and-retry",
  "human-intervention",
]);
export type RuntimeAdapterOperation = z.infer<
  typeof RuntimeAdapterOperationSchema
>;

export const RuntimeAdapterOperationSupportSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("supported") }),
    z.object({
      status: z.literal("unsupported"),
      reason: z.string(),
      recovery: z.enum([
        "retry-new-run",
        "manual-intervention",
        "legacy-fallback",
      ]),
    }),
  ],
);
export type RuntimeAdapterOperationSupport = z.infer<
  typeof RuntimeAdapterOperationSupportSchema
>;

export const RuntimeAdapterContractSchema = z.object({
  adapterId: z.enum(["codex-app-server", "claude-acp", "legacy"]),
  transportMode: DaemonTransportModeSchema,
  protocolVersion: z.union([z.literal(1), z.literal(2)]),
  session: z.object({
    requestedSessionField: z.enum(["sessionId", "acpSessionId"]).nullable(),
    resolvedSessionField: z
      .enum(["sessionId", "acpSessionId", "codexPreviousResponseId"])
      .nullable(),
    previousResponseField: z.literal("codexPreviousResponseId").nullable(),
  }),
  operations: z.record(
    RuntimeAdapterOperationSchema,
    RuntimeAdapterOperationSupportSchema,
  ),
});
export type RuntimeAdapterContract = z.infer<
  typeof RuntimeAdapterContractSchema
>;

export const DaemonMessageClaudeSchema = z
  .object({
    type: z.literal("claude"),
    token: z.string(),
    prompt: z.string(),
    model: z.string(),
    agent: AIAgentSchema,
    agentVersion: z.number(),
    sessionId: z.string().nullable(),
    threadId: z.string(),
    threadChatId: z.string(),
    featureFlags: z.record(z.string(), z.boolean()).optional() as z.ZodOptional<
      z.ZodType<FeatureFlags>
    >,
    permissionMode: z.enum(["allowAll", "plan"]).optional(),
    useCredits: z.boolean().optional(),
    runId: z.string().optional(),
    transportMode: DaemonTransportModeSchema.optional(),
    protocolVersion: z.number().int().min(1).optional(),
    acpServerId: z.string().nullable().optional(),
    acpSessionId: z.string().nullable().optional(),
    codexPreviousResponseId: z.string().nullable().optional(),
    runtimeAdapterContract: RuntimeAdapterContractSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const transportMode = value.transportMode ?? "legacy";
    if (transportMode !== "acp") {
      return;
    }
    if (!value.runId || value.runId.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runId"],
        message: "runId is required for ACP transport",
      });
    }
    if (value.protocolVersion !== 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protocolVersion"],
        message: "protocolVersion must be 2 for ACP transport",
      });
    }
    if (!value.acpServerId || value.acpServerId.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acpServerId"],
        message: "acpServerId is required for ACP transport",
      });
    }
  });

export const DaemonMessagePingSchema = z.object({
  type: z.literal("ping"),
  threadId: z.null().optional(),
  threadChatId: z.null().optional(),
  token: z.null().optional(),
});

export const DaemonMessageKillSchema = z.object({
  type: z.literal("kill"),
  threadId: z.null().optional(),
  threadChatId: z.null().optional(),
  token: z.null().optional(),
});

export const DaemonMessageStopSchema = z.object({
  type: z.literal("stop"),
  threadId: z.string(),
  threadChatId: z.string(),
  token: z.string(),
});

export const DaemonMessagePermissionResponseSchema = z.object({
  type: z.literal("permission-response"),
  threadId: z.string(),
  threadChatId: z.string(),
  token: z.string(),
  promptId: z.string(),
  optionId: z.string(),
});

export const DaemonMessageSchema = z.union([
  DaemonMessageClaudeSchema,
  DaemonMessageKillSchema,
  DaemonMessageStopSchema,
  DaemonMessagePingSchema,
  DaemonMessagePermissionResponseSchema,
]);

export type DaemonMessageClaude = z.infer<typeof DaemonMessageClaudeSchema>;
export type DaemonMessageStop = z.infer<typeof DaemonMessageStopSchema>;
export type DaemonMessagePing = z.infer<typeof DaemonMessagePingSchema>;
export type DaemonMessagePermissionResponse = z.infer<
  typeof DaemonMessagePermissionResponseSchema
>;
export type DaemonMessage = z.infer<typeof DaemonMessageSchema>;

export type ClaudeMessage =
  // An assistant message
  | {
      type: "assistant";
      message: Anthropic.MessageParam; // from Anthropic SDK
      parent_tool_use_id: string | null;
      session_id: string;
    }

  // A user message
  | {
      type: "user";
      message: Anthropic.MessageParam; // from Anthropic SDK
      parent_tool_use_id: string | null;
      session_id: string;
    }

  // A stop message
  | {
      type: "custom-stop";
      session_id: null;
      duration_ms: number;
    }

  // A custom error message
  | {
      type: "custom-error";
      session_id: null;
      duration_ms: number;
      error_info?: string;
      runtimeRecovery?: {
        operation: RuntimeAdapterOperation;
        reason: string;
        recovery: "retry-new-run" | "manual-intervention" | "legacy-fallback";
      };
    }

  // Emitted as the last message
  | {
      type: "result";
      subtype: "success";
      total_cost_usd: number;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      result: string;
      session_id: string;
    }

  // Emitted as the last message, when we've reached the maximum number of turns
  | {
      type: "result";
      subtype: "error_max_turns";
      total_cost_usd: number;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      session_id: string;
    }

  // Emitted as the last message, when there's an error
  | {
      type: "result";
      is_error: true;
      subtype: "error_during_execution";
      duration_ms: number;
      num_turns: number;
      error: string;
      session_id: string;
    }

  // Emitted as the first message at the start of a conversation
  | {
      type: "system";
      subtype: "init";
      session_id: string;
      tools: string[];
      mcp_servers: {
        name: string;
        status: string;
      }[];
    }

  // ACP tool-call lifecycle event (tool_call / tool_call_update)
  | {
      type: "acp-tool-call";
      session_id: string;
      toolCallId: string;
      title: string;
      kind:
        | "read"
        | "edit"
        | "delete"
        | "search"
        | "execute"
        | "think"
        | "fetch"
        | "other";
      status: "pending" | "in_progress" | "completed" | "failed";
      locations: Array<{
        type: string;
        path: string;
        range: unknown | null;
      }>;
      rawInput: string;
      rawOutput?: string;
      startedAt?: string;
      completedAt?: string;
      progressChunks: Array<{ seq: number; text: string }>;
    }

  // ACP plan event
  | {
      type: "acp-plan";
      session_id: string;
      entries: Array<{
        id?: string;
        content: string;
        priority: "high" | "medium" | "low";
        status: "pending" | "in_progress" | "completed";
      }>;
    }

  // Codex turn/plan/updated event — same shape as acp-plan but emitted by
  // the Codex app-server rather than ACP. Kept as a distinct discriminant so
  // the server can tell transports apart for observability; both map to the
  // same DBPlanPart in toDBMessage.
  | {
      type: "codex-plan";
      session_id: string | null;
      entries: Array<{
        id?: string;
        content: string;
        priority: "high" | "medium" | "low";
        status: "pending" | "in_progress" | "completed";
      }>;
    }

  // Codex autoApprovalReview item — risk assessment for a proposed action
  // (command execution, file change) that Codex decides whether to
  // auto-approve. Users need to see these in chat history to audit what
  // was approved vs denied. Maps to DBAutoApprovalReviewPart.
  | {
      type: "codex-auto-approval-review";
      session_id: string | null;
      reviewId: string;
      targetItemId: string;
      riskLevel: "low" | "medium" | "high";
      action: string;
      decision?: "approved" | "denied";
      rationale?: string;
      status: "pending" | "approved" | "denied";
    }

  // Codex turn/diff/updated event — unified diff snapshot of the turn's
  // pending file changes. Rendered alongside command_execution items so
  // users can see the patch the turn is proposing. Maps to DBDiffPart.
  //
  // Duplicate suppression is enforced upstream: the live daemon coalesces
  // intermediate `turn.diff_updated` events and flushes exactly one
  // `codex-diff` on `turn.completed`, and the parser dedupes identical
  // snapshots within a turn via a content hash. There is no per-row
  // upsert contract downstream — DBDiffPart rows are append-only.
  | {
      type: "codex-diff";
      session_id: string | null;
      diff: string;
    }

  // ACP image content block
  | {
      type: "acp-image";
      session_id: string;
      mimeType: string;
      data?: string;
      uri?: string;
    }

  // ACP audio content block
  | {
      type: "acp-audio";
      session_id: string;
      mimeType: string;
      data?: string;
      uri?: string;
    }

  // ACP resource_link content block
  | {
      type: "acp-resource-link";
      session_id: string;
      uri: string;
      name: string;
      title?: string;
      description?: string;
      mimeType?: string;
      size?: number;
    }

  // ACP terminal content block
  | {
      type: "acp-terminal";
      session_id: string;
      terminalId: string;
      chunks: Array<{
        streamSeq: number;
        kind: "stdout" | "stderr" | "interaction";
        text: string;
      }>;
    }

  // ACP diff content block
  | {
      type: "acp-diff";
      session_id: string;
      filePath: string;
      oldContent?: string;
      newContent: string;
      unifiedDiff?: string;
      status: "pending" | "applied" | "rejected";
    };

export type DaemonDelta = {
  messageId: string;
  partIndex: number;
  deltaSeq: number;
  kind?: "text" | "thinking";
  text: string;
};

export type DaemonEventAPIBody = {
  threadId: string;
  threadChatId: string;
  messages: ClaudeMessage[];
  timezone: string;
  transportMode?: DaemonTransportMode;
  protocolVersion?: number;
  acpServerId?: string | null;
  acpSessionId?: string | null;
  codexPreviousResponseId?: string | null;
  payloadVersion?: number;
  eventId?: string;
  runId?: string;
  seq?: number;
  /** Git HEAD sha captured after the agent turn completes, before sending terminal message. */
  headShaAtCompletion?: string | null;
  /** Canonical runtime events persisted before legacy thread patch handling. */
  canonicalEvents?: CanonicalEvent[];
  /** Token-level deltas for streaming text to clients. */
  deltas?: DaemonDelta[];
  /**
   * Meta events (token usage, rate limits, model re-routing, MCP health,
   * config warnings) — operational signals that live on a separate channel
   * from chat messages so the UI can update status chips without polluting
   * the message stream. Imported from the shared package to keep the single
   * source of truth; forward-compat: older daemons simply omit this field.
   */
  metaEvents?: ThreadMetaEvent[];
};
