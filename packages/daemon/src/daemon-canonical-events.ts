import { createHash } from "node:crypto";
import {
  type CanonicalEvent,
  type ProviderRichPartEvent,
  EVENT_ENVELOPE_VERSION,
} from "@terragon/agent/canonical-events";
import { classifyRecoverableTerminal } from "@terragon/agent/recoverable-terminal";
import {
  type AIAgent,
  type AIModel,
  AIModelSchema,
} from "@terragon/agent/types";
import { readBoolean, readString, toRecord } from "./json-read";
import {
  type ClaudeMessage,
  type DaemonTransportMode,
  resultErrorMessage,
} from "./shared";

function resolveRuntimeTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

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

export type CanonicalRunTerminal = {
  status: "completed" | "failed" | "stopped";
  errorMessage: string | null;
};

/**
 * The canonical message→terminal mapping, owned here so the daemon emits the
 * run-terminal directly: a `result` with `is_error` is `failed`, a successful
 * `result` is `completed`, `custom-stop` is `stopped`, and `custom-error` is
 * `failed`. Returns null when the batch carries no terminal message.
 */
export function deriveRunTerminalFromMessages(
  messages: ClaudeMessage[],
): CanonicalRunTerminal | null {
  for (const message of messages) {
    if (message.type === "custom-stop") {
      return { status: "stopped", errorMessage: null };
    }
    if (message.type === "custom-error") {
      return {
        status: "failed",
        errorMessage: message.error_info ?? null,
      };
    }
    if (message.type === "result") {
      if (message.is_error) {
        return { status: "failed", errorMessage: resultErrorMessage(message) };
      }
      return { status: "completed", errorMessage: null };
    }
  }
  return null;
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
  canonicalTerminalEmitted: boolean;
  streamedAssistantText: boolean;
  threadId: string;
  threadChatId: string;
  timezone?: string;
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
  canonicalTerminalEmittedAfterBatch: boolean;
};

function buildProviderRichPartEvent(
  message: ClaudeMessage,
  allocateBaseEvent: () => CanonicalBaseEvent,
): ProviderRichPartEvent | null {
  switch (message.type) {
    case "acp-plan":
      return {
        ...allocateBaseEvent(),
        category: "artifact",
        type: "provider-rich-part",
        richKind: "acp-plan",
        payload: { entries: message.entries },
      };
    case "codex-plan":
      return {
        ...allocateBaseEvent(),
        category: "artifact",
        type: "provider-rich-part",
        richKind: "codex-plan",
        payload: { entries: message.entries },
      };
    case "acp-diff":
      return {
        ...allocateBaseEvent(),
        category: "artifact",
        type: "provider-rich-part",
        richKind: "acp-diff",
        payload: {
          filePath: message.filePath,
          newContent: message.newContent,
          status: message.status,
          ...(message.oldContent !== undefined
            ? { oldContent: message.oldContent }
            : {}),
          ...(message.unifiedDiff !== undefined
            ? { unifiedDiff: message.unifiedDiff }
            : {}),
        },
      };
    case "codex-diff":
      return {
        ...allocateBaseEvent(),
        category: "artifact",
        type: "provider-rich-part",
        richKind: "codex-diff",
        payload: { diff: message.diff },
      };
    case "codex-error":
      return {
        ...allocateBaseEvent(),
        category: "artifact",
        type: "provider-rich-part",
        richKind: "codex-error",
        payload: { message: message.message },
      };
    case "codex-compaction":
      return {
        ...allocateBaseEvent(),
        category: "artifact",
        type: "provider-rich-part",
        richKind: "codex-context-compaction",
        payload: {},
      };
    case "acp-terminal":
      return {
        ...allocateBaseEvent(),
        category: "artifact",
        type: "provider-rich-part",
        richKind: "acp-terminal",
        payload: { terminalId: message.terminalId, chunks: message.chunks },
      };
    case "acp-image":
      return {
        ...allocateBaseEvent(),
        category: "artifact",
        type: "provider-rich-part",
        richKind: "acp-image",
        payload: {
          mimeType: message.mimeType,
          ...(message.data !== undefined ? { data: message.data } : {}),
          ...(message.uri !== undefined ? { uri: message.uri } : {}),
        },
      };
    case "acp-audio":
      return {
        ...allocateBaseEvent(),
        category: "artifact",
        type: "provider-rich-part",
        richKind: "acp-audio",
        payload: {
          mimeType: message.mimeType,
          ...(message.data !== undefined ? { data: message.data } : {}),
          ...(message.uri !== undefined ? { uri: message.uri } : {}),
        },
      };
    case "acp-resource-link":
      return {
        ...allocateBaseEvent(),
        category: "artifact",
        type: "provider-rich-part",
        richKind: "acp-resource-link",
        payload: {
          uri: message.uri,
          name: message.name,
          ...(message.title !== undefined ? { title: message.title } : {}),
          ...(message.description !== undefined
            ? { description: message.description }
            : {}),
          ...(message.mimeType !== undefined
            ? { mimeType: message.mimeType }
            : {}),
          ...(message.size !== undefined ? { size: message.size } : {}),
        },
      };
    case "codex-auto-approval-review":
      return {
        ...allocateBaseEvent(),
        category: "artifact",
        type: "provider-rich-part",
        richKind: "codex-auto-approval-review",
        payload: {
          reviewId: message.reviewId,
          targetItemId: message.targetItemId,
          riskLevel: message.riskLevel,
          action: message.action,
          status: message.status,
          ...(message.decision !== undefined
            ? { decision: message.decision }
            : {}),
          ...(message.rationale !== undefined
            ? { rationale: message.rationale }
            : {}),
        },
      };
    case "acp-tool-call":
      if (message.status !== "completed" && message.status !== "failed") {
        return null;
      }
      return {
        ...allocateBaseEvent(),
        category: "artifact",
        type: "provider-rich-part",
        richKind: "acp-tool-call",
        payload: {
          toolCallId: message.toolCallId,
          title: message.title,
          kind: message.kind,
          status: message.status,
          locations: message.locations,
          rawInput: message.rawInput,
          progressChunks: message.progressChunks,
          ...(message.rawOutput !== undefined
            ? { rawOutput: message.rawOutput }
            : {}),
          ...(message.startedAt !== undefined
            ? { startedAt: message.startedAt }
            : {}),
          ...(message.completedAt !== undefined
            ? { completedAt: message.completedAt }
            : {}),
        },
      };
    case "system":
      if (message.subtype !== "init") {
        return null;
      }
      return {
        ...allocateBaseEvent(),
        category: "artifact",
        type: "provider-rich-part",
        richKind: "system-init",
        payload: {
          session_id: message.session_id,
          tools: message.tools,
          mcp_servers: message.mcp_servers,
        },
      };
    case "result": {
      const resolvedResult =
        message.subtype === "success"
          ? message.result
          : message.subtype === "error_during_execution"
            ? message.error
            : undefined;
      return {
        ...allocateBaseEvent(),
        category: "artifact",
        type: "provider-rich-part",
        richKind: "result",
        payload: {
          subtype: message.subtype,
          cost_usd: "total_cost_usd" in message ? message.total_cost_usd : 0,
          duration_ms: message.duration_ms,
          duration_api_ms:
            "duration_api_ms" in message ? message.duration_api_ms : 0,
          is_error: message.is_error,
          num_turns: message.num_turns,
          session_id: message.session_id,
          ...(resolvedResult !== undefined ? { result: resolvedResult } : {}),
        },
      };
    }
    default:
      return null;
  }
}

type AssistantNarrationPart = Extract<
  ProviderRichPartEvent,
  { richKind: "assistant-narration" }
>["payload"]["parts"][number];

function isCarriedNarrationBlockType(blockType: string | null): boolean {
  return (
    blockType === "thinking" ||
    blockType === "server_tool_use" ||
    blockType === "document" ||
    blockType === "web_search_tool_result"
  );
}

function buildWebSearchContent(
  raw: unknown,
): Extract<AssistantNarrationPart, { kind: "web-search-result" }>["content"] {
  if (Array.isArray(raw)) {
    return raw.map((entry) => {
      const rec = toRecord(entry);
      const type = readString(rec, "type");
      const url = readString(rec, "url");
      const title = readString(rec, "title");
      const pageAge = readString(rec, "page_age");
      const encrypted = readString(rec, "encrypted_content");
      return {
        ...(type !== null ? { type } : {}),
        ...(url !== null ? { url } : {}),
        ...(title !== null ? { title } : {}),
        ...(pageAge !== null ? { page_age: pageAge } : {}),
        ...(encrypted !== null ? { encrypted_content: encrypted } : {}),
      };
    });
  }
  const rec = toRecord(raw);
  const type = readString(rec, "type");
  const errorCode = readString(rec, "error_code");
  return {
    ...(type !== null ? { type } : {}),
    ...(errorCode !== null ? { error_code: errorCode } : {}),
  };
}

function buildDocumentNarrationPart(
  rec: Record<string, unknown> | null,
): Extract<AssistantNarrationPart, { kind: "document" }> {
  const sourceRec = toRecord(rec?.source);
  const sourceType = readString(sourceRec, "type");
  const sourceUrl = readString(sourceRec, "url");
  const fileId = readString(sourceRec, "file_id");
  const mediaType = readString(sourceRec, "media_type");
  const hasSource =
    sourceType !== null ||
    sourceUrl !== null ||
    fileId !== null ||
    mediaType !== null;
  const title = readString(rec, "title");
  const context = readString(rec, "context");
  return {
    kind: "document",
    ...(hasSource
      ? {
          source: {
            ...(sourceType !== null ? { type: sourceType } : {}),
            ...(sourceUrl !== null ? { url: sourceUrl } : {}),
            ...(fileId !== null ? { file_id: fileId } : {}),
            ...(mediaType !== null ? { media_type: mediaType } : {}),
          },
        }
      : {}),
    ...(title !== null ? { title } : {}),
    ...(context !== null ? { context } : {}),
  };
}

function buildAssistantNarrationParts(
  content: unknown[],
  streamedAssistantText: boolean,
): AssistantNarrationPart[] {
  const parts: AssistantNarrationPart[] = [];
  for (const block of content) {
    const rec = toRecord(block);
    const blockType = readString(rec, "type");
    if (blockType === "text") {
      if (streamedAssistantText) {
        continue;
      }
      parts.push({ kind: "text", text: readString(rec, "text") ?? "" });
      continue;
    }
    if (blockType === "thinking") {
      if (streamedAssistantText) {
        continue;
      }
      const signature = readString(rec, "signature");
      parts.push({
        kind: "thinking",
        thinking: readString(rec, "thinking") ?? "",
        ...(signature !== null ? { signature } : {}),
      });
      continue;
    }
    if (blockType === "server_tool_use") {
      parts.push({
        kind: "server-tool-use",
        id: readString(rec, "id") ?? "",
        name: readString(rec, "name") ?? "",
        input: toRecord(rec?.input) ?? {},
      });
      continue;
    }
    if (blockType === "web_search_tool_result") {
      parts.push({
        kind: "web-search-result",
        toolUseId: readString(rec, "tool_use_id") ?? "",
        content: buildWebSearchContent(rec?.content),
      });
      continue;
    }
    if (blockType === "document") {
      parts.push(buildDocumentNarrationPart(rec));
      continue;
    }
  }
  return parts;
}

export function buildCanonicalEventsForBatch(
  params: BuildCanonicalEventsParams,
): BuildCanonicalEventsResult {
  const {
    runId,
    agent,
    model,
    transportMode,
    protocolVersion,
    streamedAssistantText,
    threadId,
    threadChatId,
    messages,
    onMalformedBlock,
  } = params;
  const timezone = params.timezone ?? resolveRuntimeTimezone();
  if (messages.length === 0 || agent === null) {
    return {
      canonicalEvents: [],
      nextCanonicalSeqAfterBatch: params.nextCanonicalSeq,
      canonicalRunStartedEmittedAfterBatch: params.canonicalRunStartedEmitted,
      canonicalTerminalEmittedAfterBatch: params.canonicalTerminalEmitted,
    };
  }

  const timestamp = new Date().toISOString();
  const events: CanonicalEvent[] = [];
  let nextCanonicalSeq = params.nextCanonicalSeq;
  let canonicalRunStartedEmitted = params.canonicalRunStartedEmitted;
  let canonicalTerminalEmitted = params.canonicalTerminalEmitted;
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
    const richPartEvent = buildProviderRichPartEvent(
      message,
      allocateBaseEvent,
    );
    if (richPartEvent) {
      events.push(richPartEvent);
      continue;
    }
    if (message.type === "assistant") {
      const content = message.message.content;
      if (typeof content === "string") {
        if (streamedAssistantText) {
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

      const hasCarriedNarration = content.some((block) =>
        isCarriedNarrationBlockType(readString(toRecord(block), "type")),
      );
      if (hasCarriedNarration) {
        const narrationParts = buildAssistantNarrationParts(
          content,
          streamedAssistantText,
        );
        if (narrationParts.length > 0) {
          events.push({
            ...allocateBaseEvent(),
            category: "artifact",
            type: "provider-rich-part",
            richKind: "assistant-narration",
            payload: {
              parentToolUseId: message.parent_tool_use_id,
              parts: narrationParts,
            },
          });
        }
        for (const block of content) {
          const blockRecord = toRecord(block);
          if (readString(blockRecord, "type") !== "tool_use") {
            continue;
          }
          const toolCallId = readString(blockRecord, "id");
          const name = readString(blockRecord, "name");
          if (!toolCallId || !name) {
            warnMalformedCanonicalBlock(
              "missing_tool_use_identity",
              "tool_use",
            );
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

      for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
        const block = content[blockIndex]!;
        const blockRecord = toRecord(block);
        const blockType = readString(blockRecord, "type");
        if (blockType === "text" || blockType === "thinking") {
          if (streamedAssistantText) {
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
        isError: readBoolean(blockRecord, "is_error") ?? null,
        completedAt: timestamp,
        parentToolUseId: message.parent_tool_use_id,
      });
    }
  }

  if (!canonicalTerminalEmitted) {
    const terminal = deriveRunTerminalFromMessages(messages);
    if (terminal) {
      const baseEvent = allocateBaseEvent();
      const recoverable = classifyRecoverableTerminal({
        messages,
        agent,
        timezone,
      });
      events.push({
        ...baseEvent,
        category: "operational",
        type: "run-terminal",
        status: terminal.status,
        ...(terminal.errorMessage !== null
          ? { errorMessage: terminal.errorMessage }
          : {}),
        ...(recoverable !== null ? { recoverable } : {}),
      });
      canonicalTerminalEmitted = true;
    }
  }

  return {
    canonicalEvents: events,
    nextCanonicalSeqAfterBatch: nextCanonicalSeq,
    canonicalRunStartedEmittedAfterBatch: canonicalRunStartedEmitted,
    canonicalTerminalEmittedAfterBatch: canonicalTerminalEmitted,
  };
}
