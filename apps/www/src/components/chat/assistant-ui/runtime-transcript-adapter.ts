import type {
  ThreadMessage,
  ThreadAssistantMessagePart,
  ThreadUserMessagePart,
} from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import type {
  AllToolParts,
  DBAudioPart,
  DBAutoApprovalReviewPart,
  DBDelegationMessage,
  DBPlanPart,
  DBResourceLinkPart,
  DBTerminalPart,
  UIAgentMessage,
  UIMessage,
  UIPart,
  UIStructuredPlanPart,
  UIUserMessage,
} from "@terragon/shared";
import type { UIPartExtended } from "../ui-parts-extended";
import { stringifyRuntimeValue } from "./runtime-stringify";

type RuntimeTranscriptProjection = {
  source: "runtime";
  messages: UIMessage[];
};
type RuntimeProjectionCacheEntry = {
  signature: string;
  agent: AIAgent;
  projected: UIMessage | null;
};
type RuntimeTranscriptProjector = (params: {
  runtimeMessages: readonly ThreadMessage[];
  agent: AIAgent;
}) => RuntimeTranscriptProjection;

type JSONPrimitive = string | number | boolean | null;
type JSONValue = JSONPrimitive | JSONValue[] | { [key: string]: JSONValue };
type JSONObject = { [key: string]: JSONValue };
type TerragonDataPartName =
  | "terragon.audio"
  | "terragon.resource-link"
  | "terragon.terminal"
  | "terragon.auto-approval-review"
  | "terragon.plan"
  | "terragon.plan-structured"
  | "terragon.delegation";

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
      if (part.result === undefined) {
        return {
          type: "tool",
          id: part.toolCallId,
          agent,
          name: part.toolName,
          parameters: toJSONObject(part.args),
          parts: [],
          status: "pending",
        } satisfies AllToolParts;
      }
      return {
        type: "tool",
        id: part.toolCallId,
        agent,
        name: part.toolName,
        parameters: toJSONObject(part.args),
        parts: [],
        status: part.isError ? "error" : "completed",
        result: stringifyRuntimeValue(part.result),
      } satisfies AllToolParts;
    }
    case "data":
      return terragonDataPartToUIPart(part);
    case "source":
      return null;
  }
}

function runtimeMessageToUIMessage(
  message: ThreadMessage,
  agent: AIAgent,
): UIMessage | null {
  switch (message.role) {
    case "user": {
      const parts: UIUserMessage["parts"] = [];
      for (const part of message.content) {
        const projectedPart = userPartToUIPart(part);
        if (projectedPart !== null) {
          parts.push(projectedPart);
        }
      }
      return {
        id: message.id,
        role: "user",
        parts,
      } satisfies UIUserMessage;
    }
    case "assistant": {
      const parts: UIPart[] = [];
      for (const part of message.content) {
        const projectedPart = assistantPartToUIPart(part, agent);
        if (projectedPart !== null) {
          parts.push(projectedPart as UIPart);
        }
      }
      return {
        id: message.id,
        role: "agent",
        agent,
        parts,
      } satisfies UIAgentMessage;
    }
    case "system":
      return null;
  }
}

function runtimeMessageSignature(message: ThreadMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
  });
}

export function createRuntimeTranscriptProjector(): RuntimeTranscriptProjector {
  const cache = new Map<string, RuntimeProjectionCacheEntry>();

  return ({ runtimeMessages, agent }) => {
    const projectedMessages: UIMessage[] = [];
    const liveIds = new Set<string>();

    for (const message of runtimeMessages) {
      liveIds.add(message.id);
      const signature = runtimeMessageSignature(message);
      const cached = cache.get(message.id);
      const projected =
        cached?.signature === signature && cached.agent === agent
          ? cached.projected
          : runtimeMessageToUIMessage(message, agent);

      cache.set(message.id, { signature, agent, projected });
      if (projected !== null) {
        projectedMessages.push(projected);
      }
    }

    for (const cachedId of cache.keys()) {
      if (!liveIds.has(cachedId)) {
        cache.delete(cachedId);
      }
    }

    return { source: "runtime", messages: projectedMessages };
  };
}

export function projectRuntimeTranscriptMessages(params: {
  runtimeMessages: readonly ThreadMessage[];
  agent: AIAgent;
}): RuntimeTranscriptProjection {
  const { runtimeMessages, agent } = params;

  const projectedMessages: UIMessage[] = [];
  for (const message of runtimeMessages) {
    const projected = runtimeMessageToUIMessage(message, agent);
    if (projected !== null) {
      projectedMessages.push(projected);
    }
  }

  return { source: "runtime", messages: projectedMessages };
}
