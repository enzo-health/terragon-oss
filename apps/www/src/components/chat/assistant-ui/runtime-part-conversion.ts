import type {
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
import {
  projectCompletedToolPart,
  projectPendingToolPart,
} from "../tool-part-projection";
import { stringifyRuntimeValue } from "./runtime-stringify";

export type JSONPrimitive = string | number | boolean | null;
export type JSONValue =
  | JSONPrimitive
  | JSONValue[]
  | { [key: string]: JSONValue };
export type JSONObject = { [key: string]: JSONValue };
export type RuntimeToolCallPartWithLifecycle =
  ToolCallMessagePart<JSONObject> & {
    artifact?: JSONValue;
    progressChunks?: Array<{ seq: number; text: string }>;
    progressHiddenCount?: number;
    toolStatus?: string;
  };
export type RuntimeToolArtifactPart =
  | UIImagePart
  | UIPdfPart
  | UITextFilePart
  | UIRichTextPart
  | UIPlanPart;
export type TerragonDataPartName =
  | "terragon.audio"
  | "terragon.resource-link"
  | "terragon.terminal"
  | "terragon.auto-approval-review"
  | "terragon.plan"
  | "terragon.plan-structured"
  | "terragon.delegation";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJSONValue(value: unknown): value is JSONValue {
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

export function toJSONObject(value: unknown): JSONObject {
  if (!isObject(value)) return {};
  const result: JSONObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isJSONValue(entry)) {
      result[key] = entry;
    }
  }
  return result;
}

export function isUIToolLifecycleStatus(
  status: string | undefined,
): status is UIToolLifecycleStatus {
  return (
    status === "started" ||
    status === "in_progress" ||
    status === "completed" ||
    status === "failed"
  );
}

export function runtimeToolLifecycle(part: RuntimeToolCallPartWithLifecycle) {
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

export function isTerminalPart(value: unknown): value is DBTerminalPart {
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

export function terragonDataPayload(
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

export function userPartToUIPart(
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

export function assistantPartToUIPart(
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
