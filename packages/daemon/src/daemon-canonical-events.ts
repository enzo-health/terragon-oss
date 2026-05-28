import { createHash } from "node:crypto";
import {
  type CanonicalEvent,
  EVENT_ENVELOPE_VERSION,
} from "@terragon/agent/canonical-events";
import {
  type AIAgent,
  type AIModel,
  AIModelSchema,
} from "@terragon/agent/types";
import { readBoolean, readString, toRecord } from "./json-read";
import { type ClaudeMessage, type DaemonTransportMode } from "./shared";

function stringifyCanonicalToolResult(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function getMessageFingerprint(messages: ClaudeMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

export function createCanonicalEventId(runId: string, seq: number): string {
  return createHash("sha256").update(`${runId}:canonical:${seq}`).digest("hex");
}

type CanonicalBaseEvent = Pick<
  CanonicalEvent,
  | "payloadVersion"
  | "eventId"
  | "runId"
  | "threadId"
  | "threadChatId"
  | "seq"
  | "timestamp"
>;

export function allocateCanonicalBaseEvent(params: {
  runId: string;
  threadId: string;
  threadChatId: string;
  seq: number;
  timestamp: string;
}): CanonicalBaseEvent {
  return {
    payloadVersion: EVENT_ENVELOPE_VERSION,
    eventId: createCanonicalEventId(params.runId, params.seq),
    runId: params.runId,
    threadId: params.threadId,
    threadChatId: params.threadChatId,
    seq: params.seq,
    timestamp: params.timestamp,
  };
}

export function toCanonicalModelOrNull(model: string | null): AIModel | null {
  if (!model) {
    return null;
  }
  const parsed = AIModelSchema.safeParse(model);
  return parsed.success ? parsed.data : null;
}

export function toCanonicalToolParameters(
  value: unknown,
): Record<string, unknown> {
  const record = toRecord(value);
  if (record) {
    return record;
  }
  if (value === undefined) {
    return {};
  }
  return { value };
}

export type BuildCanonicalEventsParams = {
  runId: string;
  agent: AIAgent | null;
  model: string | null;
  transportMode: DaemonTransportMode;
  protocolVersion: number;
  nextCanonicalSeq: number;
  canonicalRunStartedEmitted: boolean;
  threadId: string;
  threadChatId: string;
  messages: ClaudeMessage[];
  onMalformedBlock?: (info: {
    runId: string;
    threadId: string;
    threadChatId: string;
    blockType: string;
    reason: string;
  }) => void;
};

export type BuildCanonicalEventsResult = {
  canonicalEvents: CanonicalEvent[];
  nextCanonicalSeqAfterBatch: number;
  canonicalRunStartedEmittedAfterBatch: boolean;
};

export function buildCanonicalEventsForBatch(
  params: BuildCanonicalEventsParams,
): BuildCanonicalEventsResult {
  const {
    runId,
    agent,
    model,
    transportMode,
    protocolVersion,
    threadId,
    threadChatId,
    messages,
    onMalformedBlock,
  } = params;
  if (messages.length === 0 || agent === null) {
    return {
      canonicalEvents: [],
      nextCanonicalSeqAfterBatch: params.nextCanonicalSeq,
      canonicalRunStartedEmittedAfterBatch: params.canonicalRunStartedEmitted,
    };
  }

  const timestamp = new Date().toISOString();
  const events: CanonicalEvent[] = [];
  let nextCanonicalSeq = params.nextCanonicalSeq;
  let canonicalRunStartedEmitted = params.canonicalRunStartedEmitted;
  const allocateBaseEvent = (): CanonicalBaseEvent => {
    const baseEvent = allocateCanonicalBaseEvent({
      runId,
      threadId,
      threadChatId,
      seq: nextCanonicalSeq,
      timestamp,
    });
    nextCanonicalSeq += 1;
    return baseEvent;
  };
  const warnMalformedCanonicalBlock = (
    reason: string,
    blockType: string,
  ): void => {
    onMalformedBlock?.({
      runId,
      threadId,
      threadChatId,
      blockType,
      reason,
    });
  };

  if (!canonicalRunStartedEmitted) {
    const baseEvent = allocateBaseEvent();
    const runStartedModel = toCanonicalModelOrNull(model);
    events.push({
      ...baseEvent,
      category: "operational",
      type: "run-started",
      agent,
      transportMode,
      protocolVersion,
      ...(runStartedModel ? { model: runStartedModel } : {}),
    });
    canonicalRunStartedEmitted = true;
  }

  const canonicalModel = toCanonicalModelOrNull(model);
  for (const message of messages) {
    if (message.type === "assistant") {
      // A Codex agent_message whose text already streamed as deltas under
      // `_codexItemId` is represented solely by that delta stream; skipping
      // the whole message is safe because Codex delta-streamed messages
      // carry only text/thinking blocks (never tool_use).
      if (message._codexItemId !== undefined) {
        continue;
      }
      // W-ID.3: For Claude/ACP messages with `_claudeStreamedBlockIndices`,
      // skip only the text/thinking blocks at those indices. Tool-use blocks
      // and un-streamed text blocks still need canonical events.
      const streamedBlockSet = new Set<number>(
        message._claudeStreamedBlockIndices ?? [],
      );
      const content = message.message.content;
      if (typeof content === "string") {
        // String content maps to block index 0. If that was streamed, skip.
        if (streamedBlockSet.has(0)) {
          continue;
        }
        if (content.length === 0) {
          continue;
        }
        const baseEvent = allocateBaseEvent();
        events.push({
          ...baseEvent,
          category: "transcript",
          type: "assistant-message",
          messageId: baseEvent.eventId,
          content,
          parentToolUseId: message.parent_tool_use_id,
          ...(canonicalModel ? { model: canonicalModel } : {}),
        });
        continue;
      }

      if (!Array.isArray(content)) {
        continue;
      }

      for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
        const block = content[blockIndex]!;
        const blockRecord = toRecord(block);
        const blockType = readString(blockRecord, "type");
        if (blockType === "text" || blockType === "thinking") {
          // Skip this block if its text/thinking was already delta-streamed.
          if (streamedBlockSet.has(blockIndex)) {
            continue;
          }
          const text =
            readString(blockRecord, "text") ??
            readString(blockRecord, "thinking");
          if (!text || text.length === 0) {
            continue;
          }
          const baseEvent = allocateBaseEvent();
          events.push({
            ...baseEvent,
            category: "transcript",
            type: "assistant-message",
            messageId: baseEvent.eventId,
            content: text,
            parentToolUseId: message.parent_tool_use_id,
            ...(canonicalModel ? { model: canonicalModel } : {}),
          });
          continue;
        }
        if (blockType !== "tool_use") {
          continue;
        }
        const toolCallId = readString(blockRecord, "id");
        const name = readString(blockRecord, "name");
        if (!toolCallId || !name) {
          warnMalformedCanonicalBlock("missing_tool_use_identity", "tool_use");
          continue;
        }
        const baseEvent = allocateBaseEvent();
        events.push({
          ...baseEvent,
          category: "tool_lifecycle",
          type: "tool-call-start",
          toolCallId,
          name,
          parameters: toCanonicalToolParameters(blockRecord?.input),
          parentToolUseId: message.parent_tool_use_id,
        });
      }
      continue;
    }

    if (message.type !== "user") {
      continue;
    }

    const content = message.message.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const block of content) {
      const blockRecord = toRecord(block);
      if (readString(blockRecord, "type") !== "tool_result") {
        continue;
      }
      const toolCallId = readString(blockRecord, "tool_use_id");
      if (!toolCallId) {
        warnMalformedCanonicalBlock(
          "missing_tool_result_identity",
          "tool_result",
        );
        continue;
      }
      const baseEvent = allocateBaseEvent();
      events.push({
        ...baseEvent,
        category: "tool_lifecycle",
        type: "tool-call-result",
        toolCallId,
        result: stringifyCanonicalToolResult(blockRecord?.content),
        isError: readBoolean(blockRecord, "is_error") ?? false,
        completedAt: timestamp,
      });
    }
  }

  return {
    canonicalEvents: events,
    nextCanonicalSeqAfterBatch: nextCanonicalSeq,
    canonicalRunStartedEmittedAfterBatch: canonicalRunStartedEmitted,
  };
}
