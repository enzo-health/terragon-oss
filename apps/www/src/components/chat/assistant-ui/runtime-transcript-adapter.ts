import type {
  ThreadMessage,
  ThreadAssistantMessagePart,
  ThreadUserMessagePart,
  ToolCallMessagePart,
} from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import type {
  DBAudioPart,
  DBAutoApprovalReviewPart,
  DBDelegationMessage,
  DBPlanPart,
  DBResourceLinkPart,
  DBTerminalPart,
  UIMessage,
  UIImagePart,
  UIPdfPart,
  UIPart,
  UIPlanPart,
  UIRichTextPart,
  UIStructuredPlanPart,
  UITextFilePart,
  UIUserMessage,
  UIToolLifecycleStatus,
} from "@terragon/shared";
import type { UIPartExtended } from "../ui-parts-extended";
import type { TerragonRuntimeProjectionHint } from "../terragon-ag-ui-runtime-core";
import {
  projectCompletedToolPart,
  projectPendingToolPart,
} from "../tool-part-projection";
import { stringifyRuntimeValue } from "./runtime-stringify";

type RuntimeTranscriptProjection = {
  source: "runtime";
  messages: UIMessage[];
};
type RuntimeProjectionCacheEntry = {
  snapshot: RuntimeMessageSnapshot;
  agent: AIAgent;
  projected: UIMessage | null;
  partSnapshots: RuntimePartSnapshot[];
  projectedParts: RuntimeProjectedPart[];
};
type RuntimeTranscriptProjector = (params: {
  runtimeMessages: readonly ThreadMessage[];
  agent: AIAgent;
  projectionHint?: TerragonRuntimeProjectionHint;
}) => RuntimeTranscriptProjection;

type JSONPrimitive = string | number | boolean | null;
type JSONValue = JSONPrimitive | JSONValue[] | { [key: string]: JSONValue };
type JSONObject = { [key: string]: JSONValue };
type RuntimeToolCallPartWithLifecycle = ToolCallMessagePart<JSONObject> & {
  artifact?: JSONValue;
  progressChunks?: Array<{ seq: number; text: string }>;
  progressHiddenCount?: number;
  toolStatus?: string;
};
type RuntimeToolArtifactPart =
  | UIImagePart
  | UIPdfPart
  | UITextFilePart
  | UIRichTextPart
  | UIPlanPart;
type TerragonDataPartName =
  | "terragon.audio"
  | "terragon.resource-link"
  | "terragon.terminal"
  | "terragon.auto-approval-review"
  | "terragon.plan"
  | "terragon.plan-structured"
  | "terragon.delegation";
type RuntimeMessageSnapshot = {
  role: ThreadMessage["role"];
  parts: RuntimePartSnapshot[];
};
type RuntimePartSnapshot =
  | { type: "text" | "reasoning"; text: string }
  | { type: "image"; image: string }
  | {
      type: "file";
      mimeType: string;
      filename: string | undefined;
      data: string;
    }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: string;
      hasResult: boolean;
      result: string | null;
      isError: boolean;
      progressChunkCount: number;
      progressLastSeq: number | null;
      progressLastText: string | null;
      progressHiddenCount: number;
      toolStatus: string | null;
      artifact: string | null;
    }
  | { type: "data"; name: string; data: string }
  | { type: "source"; value: string }
  | { type: "audio"; audio: string };
type RuntimeProjectedPart =
  | UIPartExtended
  | UIUserMessage["parts"][number]
  | null;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJSONValue(value: unknown): value is JSONValue {
  if (value === null) return true;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJSONValue);
  }
  return isObject(value) && Object.values(value).every(isJSONValue);
}

function toJSONObject(value: unknown): JSONObject {
  if (!isObject(value)) return {};
  const result: JSONObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isJSONValue(entry)) {
      result[key] = entry;
    }
  }
  return result;
}

function isUIToolLifecycleStatus(
  status: string | undefined,
): status is UIToolLifecycleStatus {
  return (
    status === "started" ||
    status === "in_progress" ||
    status === "completed" ||
    status === "failed"
  );
}

function runtimeToolLifecycle(part: RuntimeToolCallPartWithLifecycle) {
  return {
    ...(part.progressChunks ? { progressChunks: part.progressChunks } : {}),
    ...(part.progressHiddenCount
      ? { progressHiddenCount: part.progressHiddenCount }
      : {}),
    ...(isUIToolLifecycleStatus(part.toolStatus)
      ? { toolStatus: part.toolStatus }
      : {}),
  };
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isPlanEntry(value: unknown): value is DBPlanPart["entries"][number] {
  if (!isObject(value)) return false;
  const priority = value.priority;
  const status = value.status;
  return (
    typeof value.content === "string" &&
    (priority === "high" || priority === "medium" || priority === "low") &&
    (status === "pending" ||
      status === "in_progress" ||
      status === "completed" ||
      status === "failed")
  );
}

function isPlanEntries(value: unknown): value is DBPlanPart["entries"] {
  return Array.isArray(value) && value.every(isPlanEntry);
}

function isTerminalPart(value: unknown): value is DBTerminalPart {
  if (!isObject(value) || value.type !== "terminal") return false;
  if (
    typeof value.sandboxId !== "string" ||
    typeof value.terminalId !== "string" ||
    !Array.isArray(value.chunks)
  ) {
    return false;
  }
  return value.chunks.every((chunk) => {
    if (!isObject(chunk)) return false;
    return (
      typeof chunk.streamSeq === "number" &&
      (chunk.kind === "stdout" ||
        chunk.kind === "stderr" ||
        chunk.kind === "interaction") &&
      typeof chunk.text === "string"
    );
  });
}

function isResourceLinkPart(value: unknown): value is DBResourceLinkPart {
  if (!isObject(value) || value.type !== "resource-link") return false;
  return (
    typeof value.uri === "string" &&
    typeof value.name === "string" &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.description === undefined ||
      typeof value.description === "string") &&
    (value.mimeType === undefined || typeof value.mimeType === "string") &&
    (value.size === undefined || typeof value.size === "number")
  );
}

function isAudioPart(value: unknown): value is DBAudioPart {
  if (!isObject(value) || value.type !== "audio") return false;
  return (
    typeof value.mimeType === "string" &&
    (value.data === undefined || typeof value.data === "string") &&
    (value.uri === undefined || typeof value.uri === "string")
  );
}

function isAutoApprovalReviewPart(
  value: unknown,
): value is DBAutoApprovalReviewPart {
  if (!isObject(value) || value.type !== "auto-approval-review") return false;
  return (
    typeof value.reviewId === "string" &&
    typeof value.targetItemId === "string" &&
    (value.riskLevel === "low" ||
      value.riskLevel === "medium" ||
      value.riskLevel === "high") &&
    typeof value.action === "string" &&
    (value.decision === undefined ||
      value.decision === "approved" ||
      value.decision === "denied") &&
    (value.rationale === undefined || typeof value.rationale === "string") &&
    (value.status === "pending" ||
      value.status === "approved" ||
      value.status === "denied")
  );
}

function isStructuredPlanPart(value: unknown): value is UIStructuredPlanPart {
  return (
    isObject(value) &&
    value.type === "plan-structured" &&
    isPlanEntries(value.entries) &&
    (value.title === undefined || typeof value.title === "string")
  );
}

function isRichTextPart(value: unknown): value is UIRichTextPart {
  if (!isObject(value) || value.type !== "rich-text") return false;
  if (!Array.isArray(value.nodes)) return false;
  return value.nodes.every(
    (node) =>
      isObject(node) &&
      (node.type === "text" ||
        node.type === "mention" ||
        node.type === "link") &&
      typeof node.text === "string",
  );
}

function isImageArtifactPart(value: unknown): value is UIImagePart {
  return (
    isObject(value) &&
    value.type === "image" &&
    typeof value.image_url === "string"
  );
}

function imageArtifactPart(value: unknown): UIImagePart | null {
  if (isImageArtifactPart(value)) return value;
  if (
    isObject(value) &&
    value.type === "image" &&
    typeof value.image === "string"
  ) {
    return { type: "image", image_url: value.image };
  }
  return null;
}

function isPdfArtifactPart(value: unknown): value is UIPdfPart {
  return (
    isObject(value) &&
    value.type === "pdf" &&
    typeof value.pdf_url === "string" &&
    (value.filename === undefined || typeof value.filename === "string")
  );
}

function isTextFileArtifactPart(value: unknown): value is UITextFilePart {
  return (
    isObject(value) &&
    value.type === "text-file" &&
    typeof value.file_url === "string" &&
    (value.filename === undefined || typeof value.filename === "string") &&
    (value.mime_type === undefined || typeof value.mime_type === "string")
  );
}

function isPlanTextArtifactPart(value: unknown): value is UIPlanPart {
  return (
    isObject(value) &&
    value.type === "plan" &&
    typeof value.planText === "string" &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.taskCount === undefined || typeof value.taskCount === "number")
  );
}

function runtimeToolArtifactPart(
  value: unknown,
): RuntimeToolArtifactPart | null {
  const image = imageArtifactPart(value);
  if (image) return image;
  if (isPdfArtifactPart(value)) return value;
  if (isTextFileArtifactPart(value)) return value;
  if (isRichTextPart(value)) return value;
  if (isPlanTextArtifactPart(value)) return value;
  return null;
}

function runtimeToolArtifactParts(value: unknown): UIPart[] {
  if (Array.isArray(value)) {
    return value.flatMap(runtimeToolArtifactParts);
  }
  if (isObject(value) && Array.isArray(value.parts)) {
    return value.parts.flatMap(runtimeToolArtifactParts);
  }
  const part = runtimeToolArtifactPart(value);
  return part ? [part] : [];
}

function structuredPlanPart(value: unknown): UIStructuredPlanPart | null {
  if (isStructuredPlanPart(value)) return value;
  if (
    !isObject(value) ||
    value.type !== "plan" ||
    !isPlanEntries(value.entries)
  ) {
    return null;
  }
  return {
    type: "plan-structured",
    entries: value.entries,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
  };
}

function isDelegationPart(value: unknown): value is DBDelegationMessage {
  if (!isObject(value) || value.type !== "delegation") return false;
  const tool = value.tool;
  const status = value.status;
  return (
    (value.model === null || typeof value.model === "string") &&
    typeof value.delegationId === "string" &&
    (tool === "spawn" || tool === "message" || tool === "kill") &&
    (status === "initiated" ||
      status === "running" ||
      status === "completed" ||
      status === "failed") &&
    typeof value.senderThreadId === "string" &&
    isStringArray(value.receiverThreadIds) &&
    typeof value.prompt === "string" &&
    typeof value.delegatedModel === "string" &&
    (value.reasoningEffort === undefined ||
      value.reasoningEffort === "minimal" ||
      value.reasoningEffort === "low" ||
      value.reasoningEffort === "medium" ||
      value.reasoningEffort === "high") &&
    isObject(value.agentsStates) &&
    Object.values(value.agentsStates).every(
      (agentStatus) =>
        agentStatus === "initiated" ||
        agentStatus === "running" ||
        agentStatus === "completed" ||
        agentStatus === "failed",
    ) &&
    (value.timestamp === undefined || typeof value.timestamp === "string")
  );
}

function isTerragonDataPartName(value: unknown): value is TerragonDataPartName {
  return (
    value === "terragon.audio" ||
    value === "terragon.resource-link" ||
    value === "terragon.terminal" ||
    value === "terragon.auto-approval-review" ||
    value === "terragon.plan" ||
    value === "terragon.plan-structured" ||
    value === "terragon.delegation"
  );
}

function terragonDataName(
  part: Extract<ThreadAssistantMessagePart, { type: "data" }>,
) {
  const payload = terragonDataPayload(part);
  if (!payload) return null;
  if (part.name !== payload.name) return null;
  return isTerragonDataPartName(payload.name) ? payload.name : null;
}

function terragonDataPayload(
  part: Extract<ThreadAssistantMessagePart, { type: "data" }>,
): { readonly name: string; readonly data: unknown } | null {
  const data: unknown = part.data;
  if (
    isObject(data) &&
    typeof data.messageId === "string" &&
    typeof data.partIndex === "number" &&
    typeof data.name === "string" &&
    "data" in data
  ) {
    return {
      name: data.name,
      data: data.data,
    };
  }
  return null;
}

function terragonDataPartToUIPart(
  part: Extract<ThreadAssistantMessagePart, { type: "data" }>,
): UIPartExtended | null {
  const name = terragonDataName(part);
  if (name === null) return null;
  const payload = terragonDataPayload(part);
  if (!payload) return null;
  const payloadPart = payload.data;
  switch (name) {
    case "terragon.audio":
      return isAudioPart(payloadPart) ? payloadPart : null;
    case "terragon.resource-link":
      return isResourceLinkPart(payloadPart) ? payloadPart : null;
    case "terragon.terminal":
      return isTerminalPart(payloadPart) ? payloadPart : null;
    case "terragon.auto-approval-review":
      return isAutoApprovalReviewPart(payloadPart) ? payloadPart : null;
    case "terragon.plan":
    case "terragon.plan-structured":
      return structuredPlanPart(payloadPart);
    case "terragon.delegation":
      return isDelegationPart(payloadPart) ? payloadPart : null;
    default:
      return null;
  }
}

function isPdfFile(part: Extract<ThreadUserMessagePart, { type: "file" }>) {
  return (
    part.mimeType === "application/pdf" ||
    part.filename?.toLowerCase().endsWith(".pdf") === true
  );
}

function isTextFile(part: Extract<ThreadUserMessagePart, { type: "file" }>) {
  return (
    part.mimeType.startsWith("text/") ||
    part.mimeType === "application/json" ||
    part.mimeType === "application/xml"
  );
}

function userPartToUIPart(
  part: ThreadUserMessagePart,
): UIUserMessage["parts"][number] | null {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return { type: "image", image_url: part.image };
    case "file":
      if (isPdfFile(part)) {
        return {
          type: "pdf",
          pdf_url: part.data,
          ...(part.filename ? { filename: part.filename } : {}),
        };
      }
      if (isTextFile(part)) {
        return {
          type: "text-file",
          file_url: part.data,
          mime_type: part.mimeType,
          ...(part.filename ? { filename: part.filename } : {}),
        };
      }
      return null;
    case "data":
    case "audio":
      return null;
  }
}

function assistantPartToUIPart(
  part: ThreadAssistantMessagePart,
  agent: AIAgent,
): UIPartExtended | null {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "reasoning":
      return { type: "thinking", thinking: part.text };
    case "image":
      return { type: "image", image_url: part.image };
    case "file":
      if (isPdfFile(part)) {
        return {
          type: "pdf",
          pdf_url: part.data,
          ...(part.filename ? { filename: part.filename } : {}),
        };
      }
      if (isTextFile(part)) {
        return {
          type: "text-file",
          file_url: part.data,
          mime_type: part.mimeType,
          ...(part.filename ? { filename: part.filename } : {}),
        };
      }
      return null;
    case "tool-call": {
      const lifecyclePart = part as RuntimeToolCallPartWithLifecycle;
      const artifactParts = runtimeToolArtifactParts(lifecyclePart.artifact);
      if (part.result === undefined) {
        return projectPendingToolPart({
          id: part.toolCallId,
          agent,
          name: part.toolName,
          parameters: toJSONObject(part.args),
          parts: artifactParts,
          lifecycle: runtimeToolLifecycle(lifecyclePart),
        });
      }
      return projectCompletedToolPart({
        id: part.toolCallId,
        agent,
        name: part.toolName,
        parameters: toJSONObject(part.args),
        parts: artifactParts,
        result: stringifyRuntimeValue(part.result),
        isError: part.isError,
        lifecycle: runtimeToolLifecycle(lifecyclePart),
      });
    }
    case "data":
      return terragonDataPartToUIPart(part);
    case "source":
      return null;
  }
}

function projectRuntimeMessage({
  message,
  agent,
  snapshot,
  cached,
}: {
  message: ThreadMessage;
  agent: AIAgent;
  snapshot: RuntimeMessageSnapshot;
  cached: RuntimeProjectionCacheEntry | undefined;
}): RuntimeProjectionCacheEntry {
  if (
    cached?.agent === agent &&
    sameRuntimeMessageSnapshot(cached.snapshot, snapshot)
  ) {
    return cached;
  }
  return runtimeMessageToUIMessageCached({ message, agent, snapshot, cached });
}

function runtimeMessageToUIMessageCached({
  message,
  agent,
  snapshot,
  cached,
}: {
  message: ThreadMessage;
  agent: AIAgent;
  snapshot: RuntimeMessageSnapshot;
  cached: RuntimeProjectionCacheEntry | undefined;
}): RuntimeProjectionCacheEntry {
  if (message.role === "system") {
    return {
      snapshot,
      agent,
      projected: null,
      partSnapshots: snapshot.parts,
      projectedParts: [],
    };
  }

  const canReuseCachedParts =
    cached?.agent === agent &&
    cached.snapshot.role === snapshot.role &&
    cached.partSnapshots.length === snapshot.parts.length;
  const projectedParts: RuntimeProjectedPart[] = [];

  for (let index = 0; index < message.content.length; index += 1) {
    const partSnapshot = snapshot.parts[index];
    if (!partSnapshot) continue;
    const cachedPartSnapshot = cached?.partSnapshots[index];
    if (
      canReuseCachedParts &&
      cachedPartSnapshot &&
      sameRuntimePartSnapshot(cachedPartSnapshot, partSnapshot)
    ) {
      projectedParts[index] = cached.projectedParts[index] ?? null;
      continue;
    }
    const part = message.content[index]!;
    projectedParts[index] =
      message.role === "user"
        ? userPartToUIPart(part as ThreadUserMessagePart)
        : assistantPartToUIPart(part as ThreadAssistantMessagePart, agent);
  }

  if (message.role === "user") {
    const parts: UIUserMessage["parts"] = [];
    for (const part of projectedParts) {
      if (part !== null) {
        parts.push(part as UIUserMessage["parts"][number]);
      }
    }
    return {
      snapshot,
      agent,
      projected: {
        id: message.id,
        role: "user",
        parts,
      },
      partSnapshots: snapshot.parts,
      projectedParts,
    };
  }

  const parts: UIPart[] = [];
  for (const part of projectedParts) {
    if (part !== null) {
      parts.push(part as UIPart);
    }
  }
  return {
    snapshot,
    agent,
    projected: {
      id: message.id,
      role: "agent",
      agent,
      parts,
    },
    partSnapshots: snapshot.parts,
    projectedParts,
  };
}

function createRuntimeMessageSnapshot(
  message: ThreadMessage,
): RuntimeMessageSnapshot {
  return {
    role: message.role,
    parts: message.content.map(runtimeMessagePartSnapshot),
  };
}

function runtimeMessagePartSnapshot(
  part: ThreadAssistantMessagePart | ThreadUserMessagePart,
): RuntimePartSnapshot {
  switch (part.type) {
    case "text":
    case "reasoning":
      return { type: part.type, text: part.text };
    case "image":
      return { type: "image", image: part.image };
    case "file":
      return {
        type: "file",
        mimeType: part.mimeType,
        filename: part.filename,
        data: part.data,
      };
    case "tool-call":
      const progressChunks =
        (part as RuntimeToolCallPartWithLifecycle).progressChunks ?? [];
      const lastProgressChunk = progressChunks.at(-1);
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: stableRuntimeValueFingerprint(part.args),
        hasResult: part.result !== undefined,
        result:
          part.result === undefined
            ? null
            : stableRuntimeValueFingerprint(part.result),
        isError: part.isError === true,
        progressChunkCount: progressChunks.length,
        progressLastSeq: lastProgressChunk?.seq ?? null,
        progressLastText: lastProgressChunk?.text ?? null,
        progressHiddenCount:
          (part as RuntimeToolCallPartWithLifecycle).progressHiddenCount ?? 0,
        toolStatus:
          (part as RuntimeToolCallPartWithLifecycle).toolStatus ?? null,
        artifact: runtimeArtifactFingerprint(
          (part as RuntimeToolCallPartWithLifecycle).artifact,
        ),
      };
    case "data":
      return {
        type: "data",
        name: part.name,
        data: runtimeDataPartFingerprint(part),
      };
    case "source":
      return { type: "source", value: stableRuntimeValueFingerprint(part) };
    case "audio":
      return {
        type: "audio",
        audio: stableRuntimeValueFingerprint(part.audio),
      };
  }
}

function sameRuntimeMessageSnapshot(
  left: RuntimeMessageSnapshot,
  right: RuntimeMessageSnapshot,
): boolean {
  if (left.role !== right.role || left.parts.length !== right.parts.length) {
    return false;
  }
  for (let index = 0; index < left.parts.length; index += 1) {
    if (!sameRuntimePartSnapshot(left.parts[index]!, right.parts[index]!)) {
      return false;
    }
  }
  return true;
}

function sameRuntimePartSnapshot(
  left: RuntimePartSnapshot,
  right: RuntimePartSnapshot,
): boolean {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "text":
    case "reasoning":
      return right.type === left.type && left.text === right.text;
    case "image":
      return right.type === "image" && left.image === right.image;
    case "file":
      return (
        right.type === "file" &&
        left.mimeType === right.mimeType &&
        left.filename === right.filename &&
        left.data === right.data
      );
    case "tool-call":
      return (
        right.type === "tool-call" &&
        left.toolCallId === right.toolCallId &&
        left.toolName === right.toolName &&
        left.args === right.args &&
        left.hasResult === right.hasResult &&
        left.result === right.result &&
        left.isError === right.isError &&
        left.progressChunkCount === right.progressChunkCount &&
        left.progressLastSeq === right.progressLastSeq &&
        left.progressLastText === right.progressLastText &&
        left.progressHiddenCount === right.progressHiddenCount &&
        left.toolStatus === right.toolStatus &&
        left.artifact === right.artifact
      );
    case "data":
      return (
        right.type === "data" &&
        left.name === right.name &&
        left.data === right.data
      );
    case "source":
      return right.type === "source" && left.value === right.value;
    case "audio":
      return right.type === "audio" && left.audio === right.audio;
  }
}

function stableRuntimeValueFingerprint(value: unknown): string {
  return stableRuntimeValueFingerprintWithCache(value);
}

function uncachedRuntimeValueFingerprint(value: unknown): string {
  return stableRuntimeValueFingerprintWithCache(value);
}

function stableRuntimeValueFingerprintWithCache(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value !== "object") return JSON.stringify(value) ?? "";
  let fingerprint: string;
  if (Array.isArray(value)) {
    fingerprint = `[${value.map(stableRuntimeValueFingerprintWithCache).join(",")}]`;
  } else {
    fingerprint = `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${stableRuntimeValueFingerprintWithCache(entry)}`,
      )
      .join(",")}}`;
  }
  return fingerprint;
}

function runtimeArtifactFingerprint(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return stableRuntimeValueFingerprint(compactArtifactFingerprintValue(value));
}

function compactArtifactFingerprintValue(value: unknown): unknown {
  if (typeof value === "string") return compactArtifactString(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return {
      length: value.length,
      first: compactArtifactFingerprintValue(value[0]),
      last: compactArtifactFingerprintValue(value.at(-1)),
    };
  }
  const record = value as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const key of [
    "type",
    "id",
    "artifactId",
    "artifactType",
    "status",
    "uri",
    "url",
    "image_url",
    "image",
    "pdf_url",
    "file_url",
    "filename",
    "mime_type",
    "mimeType",
    "size",
    "contentHash",
    "version",
    "title",
    "summary",
  ]) {
    if (key in record) {
      compact[key] = compactArtifactFingerprintValue(record[key]);
    }
  }
  if (Array.isArray(record.parts)) {
    compact.parts = compactArtifactFingerprintValue(record.parts);
  }
  if (Array.isArray(record.nodes)) {
    compact.nodes = compactArtifactSequenceFingerprint(record.nodes);
  }
  if (Array.isArray(record.entries)) {
    compact.entries = compactArtifactSequenceFingerprint(record.entries);
  }
  if (typeof record.planText === "string") {
    compact.planText = compactArtifactString(record.planText);
  }
  return compact;
}

function compactArtifactSequenceFingerprint(value: unknown[]): unknown {
  return {
    length: value.length,
    first: compactArtifactFingerprintValue(value[0]),
    last: compactArtifactFingerprintValue(value.at(-1)),
  };
}

function compactArtifactString(value: string): string {
  if (value.length <= 256) return value;
  return `${value.slice(0, 128)}:${value.length}:${value.slice(-128)}`;
}

function runtimeDataPartFingerprint(
  part: Extract<ThreadAssistantMessagePart, { type: "data" }>,
): string {
  const payload = terragonDataPayload(part);
  if (!payload) {
    return uncachedRuntimeValueFingerprint(part.data);
  }

  if (payload.name === "terragon.terminal" && isTerminalPart(payload.data)) {
    return terminalPartFingerprint(payload.data);
  }

  return uncachedRuntimeValueFingerprint(part.data);
}

function terminalPartFingerprint(part: DBTerminalPart): string {
  const lastChunk = part.chunks.at(-1);
  return stableRuntimeValueFingerprint({
    type: part.type,
    sandboxId: part.sandboxId,
    terminalId: part.terminalId,
    chunksLength: part.chunks.length,
    lastStreamSeq: lastChunk?.streamSeq ?? null,
    lastKind: lastChunk?.kind ?? null,
    lastText: lastChunk?.text ?? null,
    chunksHash: terminalChunksHash(part.chunks),
  });
}

function terminalChunksHash(chunks: DBTerminalPart["chunks"]): number {
  let hash = 0;
  for (const chunk of chunks) {
    hash = hashStringIntoHash(hash, String(chunk.streamSeq));
    hash = hashStringIntoHash(hash, chunk.kind);
    hash = hashStringIntoHash(hash, chunk.text);
  }
  return hash >>> 0;
}

function hashStringIntoHash(initialHash: number, value: string): number {
  let hash = initialHash;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}

export function createRuntimeTranscriptProjector(): RuntimeTranscriptProjector {
  const cache = new Map<string, RuntimeProjectionCacheEntry>();
  let previousAgent: AIAgent | null = null;
  let previousRuntimeMessages: readonly ThreadMessage[] = [];
  let previousProjectedByRuntimeIndex: Array<UIMessage | null> = [];
  let previousCompactIndexByRuntimeIndex: number[] = [];
  let previousProjectedMessages: UIMessage[] = [];
  let previousProjectionHintVersion = 0;

  return ({ runtimeMessages, agent, projectionHint }) => {
    const canReusePrefix = previousAgent === agent;
    const trustedFirstChangedIndex = getTrustedProjectionHintIndex({
      projectionHint,
      previousProjectionHintVersion,
      previousAgent,
      agent,
      runtimeMessages,
    });
    const firstChangedIndex = canReusePrefix
      ? resolveFirstChangedRuntimeMessageIndex({
          trustedFirstChangedIndex,
          previousRuntimeMessages,
          runtimeMessages,
        })
      : 0;
    if (
      canUseTailProjectionFastPath({
        previousAgent,
        agent,
        previousRuntimeMessages,
        runtimeMessages,
        firstChangedIndex,
      })
    ) {
      const tailIndex = runtimeMessages.length - 1;
      const message = runtimeMessages[tailIndex]!;
      const cached = cache.get(message.id);
      const snapshot = createRuntimeMessageSnapshot(message);
      const nextCacheEntry = projectRuntimeMessage({
        message,
        agent,
        snapshot,
        cached,
      });
      const projected = nextCacheEntry.projected;
      const previousProjected = previousProjectedByRuntimeIndex[tailIndex];

      cache.set(message.id, nextCacheEntry);
      previousRuntimeMessages = runtimeMessages;
      previousProjectionHintVersion =
        projectionHint?.version ?? previousProjectionHintVersion;

      if (projected === previousProjected) {
        return { source: "runtime", messages: previousProjectedMessages };
      }

      const compactIndex = previousCompactIndexByRuntimeIndex[tailIndex];
      previousProjectedByRuntimeIndex[tailIndex] = projected;

      if (compactIndex === undefined || compactIndex < 0) {
        return rebuildProjectedTranscriptState({
          runtimeMessages,
          projectedByRuntimeIndex: previousProjectedByRuntimeIndex,
          agent,
          cache,
          setState: (state) => {
            previousProjectedByRuntimeIndex = state.projectedByRuntimeIndex;
            previousCompactIndexByRuntimeIndex =
              state.compactIndexByRuntimeIndex;
            previousProjectedMessages = state.projectedMessages;
            previousProjectionHintVersion =
              projectionHint?.version ?? previousProjectionHintVersion;
          },
        });
      }

      const nextProjectedMessages = previousProjectedMessages.slice();
      if (projected === null) {
        nextProjectedMessages.splice(compactIndex, 1);
      } else {
        nextProjectedMessages[compactIndex] = projected;
      }
      previousProjectedMessages = nextProjectedMessages;
      return { source: "runtime", messages: nextProjectedMessages };
    }

    const firstProjectedIndex =
      runtimeMessages.length > 0
        ? Math.min(firstChangedIndex, runtimeMessages.length - 1)
        : 0;
    const projectedByRuntimeIndex =
      firstProjectedIndex > 0
        ? previousProjectedByRuntimeIndex.slice(0, firstProjectedIndex)
        : [];
    const compactIndexByRuntimeIndex =
      firstProjectedIndex > 0
        ? previousCompactIndexByRuntimeIndex.slice(0, firstProjectedIndex)
        : [];
    let changed =
      previousAgent !== agent ||
      previousRuntimeMessages.length !== runtimeMessages.length;

    for (
      let index = firstProjectedIndex;
      index < runtimeMessages.length;
      index += 1
    ) {
      const message = runtimeMessages[index]!;
      const previousProjected = previousProjectedByRuntimeIndex[index];
      if (
        canReusePrefix &&
        index > firstChangedIndex &&
        previousRuntimeMessages[index] === message &&
        previousProjected !== undefined
      ) {
        projectedByRuntimeIndex[index] = previousProjected;
        continue;
      }

      const cached = cache.get(message.id);
      const snapshot = createRuntimeMessageSnapshot(message);
      const nextCacheEntry = projectRuntimeMessage({
        message,
        agent,
        snapshot,
        cached,
      });
      const projected = nextCacheEntry.projected;

      cache.set(message.id, nextCacheEntry);
      projectedByRuntimeIndex[index] = projected;
      if (projected !== previousProjectedByRuntimeIndex[index]) {
        changed = true;
      }
    }

    if (
      shouldPruneRuntimeProjectionCache(
        previousRuntimeMessages,
        runtimeMessages,
      )
    ) {
      pruneRuntimeProjectionCache(cache, runtimeMessages);
    }

    const projectedMessages: UIMessage[] = [];
    for (let index = 0; index < projectedByRuntimeIndex.length; index += 1) {
      const projected = projectedByRuntimeIndex[index] ?? null;
      if (projected !== null) {
        compactIndexByRuntimeIndex[index] = projectedMessages.length;
        projectedMessages.push(projected);
      } else {
        compactIndexByRuntimeIndex[index] = -1;
      }
    }

    if (
      !changed &&
      projectedMessages.length === previousProjectedMessages.length &&
      projectedMessages.every(
        (message, index) => message === previousProjectedMessages[index],
      )
    ) {
      return { source: "runtime", messages: previousProjectedMessages };
    }

    previousAgent = agent;
    previousRuntimeMessages = runtimeMessages;
    previousProjectedByRuntimeIndex = projectedByRuntimeIndex;
    previousCompactIndexByRuntimeIndex = compactIndexByRuntimeIndex;
    previousProjectedMessages = projectedMessages;
    previousProjectionHintVersion =
      projectionHint?.version ?? previousProjectionHintVersion;
    return { source: "runtime", messages: projectedMessages };
  };
}

type ProjectedTranscriptState = {
  projectedByRuntimeIndex: Array<UIMessage | null>;
  compactIndexByRuntimeIndex: number[];
  projectedMessages: UIMessage[];
};

function canUseTailProjectionFastPath({
  previousAgent,
  agent,
  previousRuntimeMessages,
  runtimeMessages,
  firstChangedIndex,
}: {
  previousAgent: AIAgent | null;
  agent: AIAgent;
  previousRuntimeMessages: readonly ThreadMessage[];
  runtimeMessages: readonly ThreadMessage[];
  firstChangedIndex: number;
}): boolean {
  if (
    previousAgent !== agent ||
    runtimeMessages.length === 0 ||
    previousRuntimeMessages.length !== runtimeMessages.length
  ) {
    return false;
  }

  const tailIndex = runtimeMessages.length - 1;
  return (
    firstChangedIndex >= tailIndex &&
    previousRuntimeMessages[tailIndex]?.id === runtimeMessages[tailIndex]?.id
  );
}

function resolveFirstChangedRuntimeMessageIndex({
  trustedFirstChangedIndex,
  previousRuntimeMessages,
  runtimeMessages,
}: {
  trustedFirstChangedIndex: number | null;
  previousRuntimeMessages: readonly ThreadMessage[];
  runtimeMessages: readonly ThreadMessage[];
}): number {
  const referenceFirstChangedIndex = getFirstChangedRuntimeMessageIndex(
    previousRuntimeMessages,
    runtimeMessages,
  );
  if (trustedFirstChangedIndex === null) {
    return referenceFirstChangedIndex;
  }
  return Math.min(trustedFirstChangedIndex, referenceFirstChangedIndex);
}

function getTrustedProjectionHintIndex({
  projectionHint,
  previousProjectionHintVersion,
  previousAgent,
  agent,
  runtimeMessages,
}: {
  projectionHint: TerragonRuntimeProjectionHint | undefined;
  previousProjectionHintVersion: number;
  previousAgent: AIAgent | null;
  agent: AIAgent;
  runtimeMessages: readonly ThreadMessage[];
}): number | null {
  if (
    !projectionHint ||
    projectionHint.version <= previousProjectionHintVersion ||
    previousAgent !== agent ||
    projectionHint.firstChangedRuntimeMessageIndex === null
  ) {
    return null;
  }
  if (
    projectionHint.firstChangedRuntimeMessageIndex < 0 ||
    projectionHint.firstChangedRuntimeMessageIndex > runtimeMessages.length
  ) {
    return null;
  }
  return projectionHint.firstChangedRuntimeMessageIndex;
}

function rebuildProjectedTranscriptState({
  runtimeMessages,
  projectedByRuntimeIndex,
  agent,
  cache,
  setState,
}: {
  runtimeMessages: readonly ThreadMessage[];
  projectedByRuntimeIndex: Array<UIMessage | null>;
  agent: AIAgent;
  cache: Map<string, RuntimeProjectionCacheEntry>;
  setState: (state: ProjectedTranscriptState) => void;
}): RuntimeTranscriptProjection {
  const nextProjectedByRuntimeIndex = projectedByRuntimeIndex.slice(
    0,
    runtimeMessages.length,
  );
  const compactIndexByRuntimeIndex: number[] = [];
  const projectedMessages: UIMessage[] = [];

  for (let index = 0; index < runtimeMessages.length; index += 1) {
    const message = runtimeMessages[index]!;
    let projected = nextProjectedByRuntimeIndex[index];
    if (projected === undefined) {
      const cached = cache.get(message.id);
      const snapshot = createRuntimeMessageSnapshot(message);
      const nextCacheEntry = projectRuntimeMessage({
        message,
        agent,
        snapshot,
        cached,
      });
      projected = nextCacheEntry.projected;
      cache.set(message.id, nextCacheEntry);
      nextProjectedByRuntimeIndex[index] = projected;
    }
    if (projected !== null) {
      compactIndexByRuntimeIndex[index] = projectedMessages.length;
      projectedMessages.push(projected);
    } else {
      compactIndexByRuntimeIndex[index] = -1;
    }
  }

  setState({
    projectedByRuntimeIndex: nextProjectedByRuntimeIndex,
    compactIndexByRuntimeIndex,
    projectedMessages,
  });
  return { source: "runtime", messages: projectedMessages };
}

function getFirstChangedRuntimeMessageIndex(
  previous: readonly ThreadMessage[],
  current: readonly ThreadMessage[],
): number {
  const sharedLength = Math.min(previous.length, current.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (previous[index] !== current[index]) {
      return index;
    }
  }
  return sharedLength;
}

function shouldPruneRuntimeProjectionCache(
  previous: readonly ThreadMessage[],
  current: readonly ThreadMessage[],
): boolean {
  if (current.length < previous.length) {
    return true;
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index]?.id !== current[index]?.id) {
      return true;
    }
  }
  return false;
}

function pruneRuntimeProjectionCache(
  cache: Map<string, RuntimeProjectionCacheEntry>,
  runtimeMessages: readonly ThreadMessage[],
) {
  const liveIds = new Set(runtimeMessages.map((message) => message.id));
  for (const cachedId of cache.keys()) {
    if (!liveIds.has(cachedId)) {
      cache.delete(cachedId);
    }
  }
}
