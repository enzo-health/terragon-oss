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
    idempotencyKey: z.string().min(1),
  })
  .passthrough();
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
  isError: z.boolean(),
  completedAt: TimestampSchema,
});
export type ToolCallResultEvent = z.infer<typeof ToolCallResultEventSchema>;

export const CanonicalEventSchema = z.union([
  OperationalRunStartedEventSchema,
  AssistantMessageEventSchema,
  ToolCallStartEventSchema,
  ToolCallResultEventSchema,
]);
export type CanonicalEvent = z.infer<typeof CanonicalEventSchema>;
