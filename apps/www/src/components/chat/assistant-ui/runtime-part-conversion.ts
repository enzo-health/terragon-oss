import type {
  ThreadAssistantMessagePart,
  ThreadUserMessagePart,
  ToolCallMessagePart,
} from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import type {
  UIImagePart,
  UIPdfPart,
  UIPart,
  UIPlanPart,
  UIRichTextPart,
  UIStructuredPlanPart,
  UITextFilePart,
  UIUserMessage,
} from "@terragon/shared";
import type { UIPartExtended } from "../ui-parts-extended";
import {
  projectCompletedToolPart,
  projectPendingToolPart,
} from "../tool-part-projection";
import { stringifyRuntimeValue } from "./runtime-stringify";
import {
  isAudioPart,
  isAutoApprovalReviewPart,
  isDelegationPart,
  isImageArtifactPart,
  isJSONValue,
  isObject,
  isPdfArtifactPart,
  isPlanEntries,
  isPlanTextArtifactPart,
  isResourceLinkPart,
  isRichTextPart,
  isStructuredPlanPart,
  isTerminalPart,
  isTerragonDataPartName,
  isTextFileArtifactPart,
  isUIToolLifecycleStatus,
} from "./runtime-part-guards";

export type {
  JSONObject,
  JSONPrimitive,
  JSONValue,
  TerragonDataPartName,
} from "./runtime-part-guards";
export { isTerminalPart } from "./runtime-part-guards";

import type { JSONObject, JSONValue } from "./runtime-part-guards";

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
