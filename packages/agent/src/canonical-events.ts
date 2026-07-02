import * as z from "zod/v4";
import { AIAgentSchema, AIModelSchema } from "./types";

export const EVENT_ENVELOPE_VERSION = 2;

export const EventIdSchema = z.string().min(1);
export type EventId = z.infer<typeof EventIdSchema>;

export const RunIdSchema = z.string().min(1);
export type RunId = z.infer<typeof RunIdSchema>;

export const ThreadIdSchema = z.string().min(1);
export type ThreadId = z.infer<typeof ThreadIdSchema>;

export const ThreadChatIdSchema = z.string().min(1);
export type ThreadChatId = z.infer<typeof ThreadChatIdSchema>;

export const MessageIdSchema = z.string().min(1);
export type MessageId = z.infer<typeof MessageIdSchema>;

export const ToolCallIdSchema = z.string().min(1);
export type ToolCallId = z.infer<typeof ToolCallIdSchema>;

export const SeqSchema = z.number().int().nonnegative();
export type Seq = z.infer<typeof SeqSchema>;

export const TimestampSchema = z.string().datetime();
export type Timestamp = z.infer<typeof TimestampSchema>;

export const EventCategorySchema = z.enum([
  "operational",
  "transcript",
  "tool_lifecycle",
  "reasoning",
  "artifact",
  "permission",
  "meta",
  "quarantine",
]);
export type EventCategory = z.infer<typeof EventCategorySchema>;

const TransportModeSchema = z.enum(["legacy", "acp", "codex-app-server"]);
export type TransportMode = z.infer<typeof TransportModeSchema>;

export const BaseEventEnvelopeSchema = z
  .object({
    payloadVersion: z.literal(EVENT_ENVELOPE_VERSION),
    eventId: EventIdSchema,
    runId: RunIdSchema,
    threadId: ThreadIdSchema,
    threadChatId: ThreadChatIdSchema,
    seq: SeqSchema,
    timestamp: TimestampSchema,
    idempotencyKey: z.string().min(1).optional(),
  })
  .strict();
export type BaseEventEnvelope = z.infer<typeof BaseEventEnvelopeSchema>;

export const OperationalRunStartedEventSchema = BaseEventEnvelopeSchema.extend({
  category: z.literal("operational"),
  type: z.literal("run-started"),
  agent: AIAgentSchema,
  model: AIModelSchema.optional(),
  parentRunId: RunIdSchema.nullable().optional(),
  transportMode: TransportModeSchema,
  protocolVersion: z.number().int().positive(),
});
export type OperationalRunStartedEvent = z.infer<
  typeof OperationalRunStartedEventSchema
>;

export const RecoverableTerminalSchema = z.object({
  kind: z.enum(["rate-limit", "oauth-token-revoked", "context-exhausted"]),
  retryAfterMs: z.number().optional(),
  detail: z.string().optional(),
});
export type RecoverableTerminal = z.infer<typeof RecoverableTerminalSchema>;

export const OperationalRunTerminalEventSchema = BaseEventEnvelopeSchema.extend(
  {
    category: z.literal("operational"),
    type: z.literal("run-terminal"),
    status: z.enum(["completed", "failed", "stopped"]),
    errorMessage: z.string().nullable().optional(),
    errorCode: z.string().min(1).nullable().optional(),
    headShaAtCompletion: z.string().min(1).nullable().optional(),
    // Present when the daemon classified this terminal as a RECOVERABLE failure
    // (rate-limit re-queue, OAuth refresh+retry, or auto-compact+retry). The
    // server defers to the message-based recovery path instead of fencing the
    // run. Absent on non-recoverable terminals and on bundles predating K2.
    recoverable: RecoverableTerminalSchema.optional(),
  },
);
export type OperationalRunTerminalEvent = z.infer<
  typeof OperationalRunTerminalEventSchema
>;

export const AssistantMessageEventSchema = BaseEventEnvelopeSchema.extend({
  category: z.literal("transcript"),
  type: z.literal("assistant-message"),
  messageId: MessageIdSchema,
  content: z.string(),
  model: AIModelSchema.optional(),
  parentToolUseId: z.string().min(1).nullable().optional(),
});
export type AssistantMessageEvent = z.infer<typeof AssistantMessageEventSchema>;

export const ToolCallStartEventSchema = BaseEventEnvelopeSchema.extend({
  category: z.literal("tool_lifecycle"),
  type: z.literal("tool-call-start"),
  toolCallId: ToolCallIdSchema,
  name: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  parentToolUseId: z.string().min(1).nullable().optional(),
});
export type ToolCallStartEvent = z.infer<typeof ToolCallStartEventSchema>;

export const ToolCallResultEventSchema = BaseEventEnvelopeSchema.extend({
  category: z.literal("tool_lifecycle"),
  type: z.literal("tool-call-result"),
  toolCallId: ToolCallIdSchema,
  result: z.string(),
  isError: z.boolean().nullable(),
  completedAt: TimestampSchema,
  parentToolUseId: z.string().min(1).nullable().optional(),
});
export type ToolCallResultEvent = z.infer<typeof ToolCallResultEventSchema>;

export const ToolCallProgressEventSchema = BaseEventEnvelopeSchema.extend({
  category: z.literal("tool_lifecycle"),
  type: z.literal("tool-call-progress"),
  toolCallId: ToolCallIdSchema,
  delta: z.string(),
  progressKind: z
    .enum(["args", "stdout", "stderr", "status", "artifact"])
    .optional(),
});
export type ToolCallProgressEvent = z.infer<typeof ToolCallProgressEventSchema>;

export const ReasoningMessageEventSchema = BaseEventEnvelopeSchema.extend({
  category: z.literal("reasoning"),
  type: z.literal("reasoning-message"),
  messageId: MessageIdSchema,
  content: z.string(),
  model: AIModelSchema.optional(),
});
export type ReasoningMessageEvent = z.infer<typeof ReasoningMessageEventSchema>;

export const PermissionRequestEventSchema = BaseEventEnvelopeSchema.extend({
  category: z.literal("permission"),
  type: z.literal("permission-request"),
  permissionRequestId: z.string().min(1),
  toolCallId: ToolCallIdSchema.nullable().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  options: z.array(z.enum(["approve", "deny"])).min(1),
});
export type PermissionRequestEvent = z.infer<
  typeof PermissionRequestEventSchema
>;

export const PermissionResponseEventSchema = BaseEventEnvelopeSchema.extend({
  category: z.literal("permission"),
  type: z.literal("permission-response"),
  permissionRequestId: z.string().min(1),
  response: z.enum(["approved", "denied"]),
});
export type PermissionResponseEvent = z.infer<
  typeof PermissionResponseEventSchema
>;

export const ArtifactReferenceEventSchema = BaseEventEnvelopeSchema.extend({
  category: z.literal("artifact"),
  type: z.literal("artifact-reference"),
  artifactId: z.string().min(1),
  artifactType: z.enum([
    "diff",
    "terminal",
    "image",
    "audio",
    "resource-link",
    "plan",
    "log",
  ]),
  title: z.string().min(1),
  uri: z.string().min(1).optional(),
  status: z.enum(["pending", "ready", "failed"]),
});
export type ArtifactReferenceEvent = z.infer<
  typeof ArtifactReferenceEventSchema
>;

export const MetaEventSchema = BaseEventEnvelopeSchema.extend({
  category: z.literal("meta"),
  type: z.literal("meta"),
  name: z.string().min(1),
  value: z.record(z.string(), z.unknown()),
});
export type MetaEvent = z.infer<typeof MetaEventSchema>;

export const UnknownProviderEventSchema = BaseEventEnvelopeSchema.extend({
  category: z.literal("quarantine"),
  type: z.literal("unknown-provider-event"),
  provider: TransportModeSchema,
  reason: z.string().min(1),
  rawEventType: z.string().min(1).optional(),
  redactedPayload: z.record(z.string(), z.unknown()),
});
export type UnknownProviderEvent = z.infer<typeof UnknownProviderEventSchema>;

const RichPlanEntrySchema = z.object({
  id: z.string().optional(),
  content: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  status: z.enum(["pending", "in_progress", "completed"]),
});

const RichPlanPayloadSchema = z.object({
  entries: z.array(RichPlanEntrySchema),
});

const RichAcpToolCallPayloadSchema = z.object({
  toolCallId: z.string(),
  title: z.string(),
  kind: z.enum([
    "read",
    "edit",
    "delete",
    "search",
    "execute",
    "think",
    "fetch",
    "other",
  ]),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  locations: z.array(
    z.object({
      type: z.string(),
      path: z.string(),
      range: z.unknown().nullable(),
    }),
  ),
  rawInput: z.string(),
  rawOutput: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  progressChunks: z.array(z.object({ seq: z.number(), text: z.string() })),
});

const RichAutoApprovalReviewPayloadSchema = z.object({
  reviewId: z.string(),
  targetItemId: z.string(),
  riskLevel: z.enum(["low", "medium", "high"]),
  action: z.string(),
  decision: z.enum(["approved", "denied"]).optional(),
  rationale: z.string().optional(),
  status: z.enum(["pending", "approved", "denied"]),
});

const RichCodexDiffPayloadSchema = z.object({ diff: z.string() });

const RichCodexErrorPayloadSchema = z.object({ message: z.string() });

const RichImagePayloadSchema = z.object({
  mimeType: z.string(),
  data: z.string().optional(),
  uri: z.string().optional(),
});

const RichResourceLinkPayloadSchema = z.object({
  uri: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
});

const RichTerminalPayloadSchema = z.object({
  terminalId: z.string(),
  chunks: z.array(
    z.object({
      streamSeq: z.number(),
      kind: z.enum(["stdout", "stderr", "interaction"]),
      text: z.string(),
    }),
  ),
});

const RichAcpDiffPayloadSchema = z.object({
  filePath: z.string(),
  oldContent: z.string().optional(),
  newContent: z.string(),
  unifiedDiff: z.string().optional(),
  status: z.enum(["pending", "applied", "rejected"]),
});

const RichMetaInitPayloadSchema = z.object({
  session_id: z.string(),
  tools: z.array(z.string()),
  mcp_servers: z.array(z.object({ name: z.string(), status: z.string() })),
});

const RichMetaResultPayloadSchema = z.object({
  subtype: z.enum(["success", "error_max_turns", "error_during_execution"]),
  cost_usd: z.number(),
  duration_ms: z.number(),
  duration_api_ms: z.number(),
  is_error: z.boolean(),
  num_turns: z.number(),
  result: z.string().optional(),
  session_id: z.string(),
});

const AssistantNarrationWebSearchEntrySchema = z.object({
  type: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  page_age: z.string().optional(),
  encrypted_content: z.string().optional(),
});

const AssistantNarrationWebSearchContentSchema = z.union([
  z.array(AssistantNarrationWebSearchEntrySchema),
  z.object({ type: z.string().optional(), error_code: z.string().optional() }),
]);

const AssistantNarrationDocumentSourceSchema = z.object({
  type: z.string().optional(),
  url: z.string().optional(),
  file_id: z.string().optional(),
  media_type: z.string().optional(),
});

const AssistantNarrationPartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({
    kind: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string().optional(),
  }),
  z.object({
    kind: z.literal("server-tool-use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("web-search-result"),
    toolUseId: z.string(),
    content: AssistantNarrationWebSearchContentSchema,
  }),
  z.object({
    kind: z.literal("document"),
    source: AssistantNarrationDocumentSourceSchema.optional(),
    title: z.string().optional(),
    context: z.string().optional(),
  }),
]);

const RichAssistantNarrationPayloadSchema = z.object({
  parentToolUseId: z.string().nullable(),
  parts: z.array(AssistantNarrationPartSchema),
});

const richPartVariant = <K extends string, P extends z.ZodType>(
  richKind: K,
  payload: P,
) =>
  BaseEventEnvelopeSchema.extend({
    category: z.literal("artifact"),
    type: z.literal("provider-rich-part"),
    richKind: z.literal(richKind),
    payload,
  });

export const ProviderRichPartEventSchema = z.discriminatedUnion("richKind", [
  richPartVariant("acp-tool-call", RichAcpToolCallPayloadSchema),
  richPartVariant("acp-plan", RichPlanPayloadSchema),
  richPartVariant("codex-plan", RichPlanPayloadSchema),
  richPartVariant(
    "codex-auto-approval-review",
    RichAutoApprovalReviewPayloadSchema,
  ),
  richPartVariant("codex-diff", RichCodexDiffPayloadSchema),
  richPartVariant("codex-error", RichCodexErrorPayloadSchema),
  richPartVariant("acp-image", RichImagePayloadSchema),
  richPartVariant("acp-audio", RichImagePayloadSchema),
  richPartVariant("acp-resource-link", RichResourceLinkPayloadSchema),
  richPartVariant("acp-terminal", RichTerminalPayloadSchema),
  richPartVariant("acp-diff", RichAcpDiffPayloadSchema),
  richPartVariant("system-init", RichMetaInitPayloadSchema),
  richPartVariant("result", RichMetaResultPayloadSchema),
  richPartVariant("assistant-narration", RichAssistantNarrationPayloadSchema),
]);
export type ProviderRichPartEvent = z.infer<typeof ProviderRichPartEventSchema>;
export type ProviderRichPartKind = ProviderRichPartEvent["richKind"];

type DistributivePick<T, K extends keyof T> = T extends unknown
  ? Pick<T, K>
  : never;
export type ProviderRichPart = DistributivePick<
  ProviderRichPartEvent,
  "richKind" | "payload"
>;

export const CanonicalEventSchema = z.union([
  OperationalRunStartedEventSchema,
  OperationalRunTerminalEventSchema,
  AssistantMessageEventSchema,
  ToolCallStartEventSchema,
  ToolCallProgressEventSchema,
  ToolCallResultEventSchema,
  ReasoningMessageEventSchema,
  PermissionRequestEventSchema,
  PermissionResponseEventSchema,
  ArtifactReferenceEventSchema,
  MetaEventSchema,
  ProviderRichPartEventSchema,
  UnknownProviderEventSchema,
]);
export type CanonicalEvent = z.infer<typeof CanonicalEventSchema>;
