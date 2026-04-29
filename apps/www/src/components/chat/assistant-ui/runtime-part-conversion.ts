import type {
  MessagePartStatus,
  ThreadAssistantMessagePart,
  ThreadUserMessagePart,
  ToolCallMessagePartStatus,
} from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import type { AllToolParts, UIRichTextPart } from "@terragon/shared";
import type { ReactNode } from "react";
import type { UIPartExtended } from "../ui-parts-extended";
import { stringifyRuntimeValue } from "./runtime-stringify";

type RuntimeBasePartState = (
  | ThreadUserMessagePart
  | ThreadAssistantMessagePart
) & {
  readonly status: MessagePartStatus | ToolCallMessagePartStatus;
};

export type RuntimeMessagePartState = Parameters<
  (value: {
    part:
      | (Extract<RuntimeBasePartState, { type: "tool-call" }> & {
          readonly toolUI: ReactNode;
        })
      | (Extract<RuntimeBasePartState, { type: "data" }> & {
          readonly dataRendererUI: ReactNode;
        })
      | Exclude<RuntimeBasePartState, { type: "tool-call" } | { type: "data" }>;
  }) => ReactNode
>[0]["part"];

type JSONPrimitive = string | number | boolean | null;
type JSONValue = JSONPrimitive | JSONValue[] | { [key: string]: JSONValue };
type JSONObject = { [key: string]: JSONValue };

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

function isPdfFile(part: { mimeType: string; filename?: string }): boolean {
  return (
    part.mimeType === "application/pdf" ||
    part.filename?.toLowerCase().endsWith(".pdf") === true
  );
}

function isTextFile(part: { mimeType: string }): boolean {
  return (
    part.mimeType.startsWith("text/") ||
    part.mimeType === "application/json" ||
    part.mimeType === "application/xml"
  );
}

function isRichTextNodes(value: unknown): value is UIRichTextPart["nodes"] {
  return (
    Array.isArray(value) &&
    value.every(
      (node) =>
        isObject(node) &&
        (node.type === "text" ||
          node.type === "mention" ||
          node.type === "link") &&
        typeof node.text === "string",
    )
  );
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

function hasArray(value: Record<string, unknown>, key: string): boolean {
  return Array.isArray(value[key]);
}

function isTerragonDataPart(value: unknown): value is UIPartExtended {
  if (!isObject(value) || typeof value.type !== "string") return false;

  switch (value.type) {
    case "text":
      return hasString(value, "text");
    case "thinking":
      return hasString(value, "thinking");
    case "image":
      return hasString(value, "image_url");
    case "rich-text":
      return isRichTextNodes(value.nodes);
    case "pdf":
      return hasString(value, "pdf_url");
    case "text-file":
      return hasString(value, "file_url");
    case "plan":
      return hasString(value, "planText") || hasArray(value, "entries");
    case "audio":
      return hasString(value, "mimeType");
    case "resource-link":
      return hasString(value, "uri") && hasString(value, "name");
    case "terminal":
      return (
        hasString(value, "sandboxId") &&
        hasString(value, "terminalId") &&
        hasArray(value, "chunks")
      );
    case "diff":
      return (
        hasString(value, "filePath") &&
        hasString(value, "newContent") &&
        (value.status === "pending" ||
          value.status === "applied" ||
          value.status === "rejected")
      );
    case "auto-approval-review":
      return (
        hasString(value, "reviewId") &&
        hasString(value, "targetItemId") &&
        hasString(value, "action") &&
        (value.riskLevel === "low" ||
          value.riskLevel === "medium" ||
          value.riskLevel === "high") &&
        (value.status === "pending" ||
          value.status === "approved" ||
          value.status === "denied")
      );
    case "plan-structured":
      return hasArray(value, "entries");
    case "server-tool-use":
      return hasString(value, "id") && hasString(value, "name");
    case "web-search-result":
      return hasString(value, "toolUseId");
    case "delegation":
      return hasString(value, "id");
    case "delegation-stub":
      return (
        hasString(value, "id") &&
        hasString(value, "agentName") &&
        hasString(value, "message") &&
        hasString(value, "status")
      );
    default:
      return false;
  }
}

type TerragonDataPartName =
  | "terragon.audio"
  | "terragon.resource-link"
  | "terragon.terminal"
  | "terragon.auto-approval-review"
  | "terragon.plan"
  | "terragon.plan-structured"
  | "terragon.delegation";

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

function isTerragonDataBridgePayload(value: unknown): value is {
  readonly name: TerragonDataPartName;
  readonly data: unknown;
} {
  return (
    isObject(value) &&
    typeof value.messageId === "string" &&
    typeof value.partIndex === "number" &&
    isTerragonDataPartName(value.name) &&
    "data" in value
  );
}

function dataPartMatchesName(
  name: TerragonDataPartName,
  part: UIPartExtended,
): boolean {
  switch (name) {
    case "terragon.audio":
      return part.type === "audio";
    case "terragon.resource-link":
      return part.type === "resource-link";
    case "terragon.terminal":
      return part.type === "terminal";
    case "terragon.auto-approval-review":
      return part.type === "auto-approval-review";
    case "terragon.plan":
      return part.type === "plan";
    case "terragon.plan-structured":
      return part.type === "plan-structured";
    case "terragon.delegation":
      return part.type === "delegation";
  }
}

function dataPartToTerragonPart(
  part: RuntimeMessagePartState,
): UIPartExtended | null {
  if (part.type !== "data") return null;
  const payload = isTerragonDataBridgePayload(part.data) ? part.data : null;
  if (!payload || part.name !== payload.name) return null;
  const data = payload.data;
  if (!isTerragonDataPart(data)) return null;
  return dataPartMatchesName(payload.name, data) ? data : null;
}

export function runtimePartToTerragonPart(
  part: RuntimeMessagePartState,
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
    case "tool-call":
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
    case "data":
      return dataPartToTerragonPart(part);
    case "source":
    case "audio":
      return null;
  }
}
