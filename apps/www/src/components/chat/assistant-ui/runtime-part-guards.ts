import type {
  DBAudioPart,
  DBAutoApprovalReviewPart,
  DBDelegationMessage,
  DBPlanPart,
  DBResourceLinkPart,
  DBTerminalPart,
  UIImagePart,
  UIPdfPart,
  UIPlanPart,
  UIRichTextPart,
  UIStructuredPlanPart,
  UITextFilePart,
  UIToolLifecycleStatus,
} from "@terragon/shared";

export type JSONPrimitive = string | number | boolean | null;
export type JSONValue =
  | JSONPrimitive
  | JSONValue[]
  | { [key: string]: JSONValue };
export type JSONObject = { [key: string]: JSONValue };
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

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

export function isPlanEntry(
  value: unknown,
): value is DBPlanPart["entries"][number] {
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

export function isPlanEntries(value: unknown): value is DBPlanPart["entries"] {
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

export function isResourceLinkPart(
  value: unknown,
): value is DBResourceLinkPart {
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

export function isAudioPart(value: unknown): value is DBAudioPart {
  if (!isObject(value) || value.type !== "audio") return false;
  return (
    typeof value.mimeType === "string" &&
    (value.data === undefined || typeof value.data === "string") &&
    (value.uri === undefined || typeof value.uri === "string")
  );
}

export function isAutoApprovalReviewPart(
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

export function isStructuredPlanPart(
  value: unknown,
): value is UIStructuredPlanPart {
  return (
    isObject(value) &&
    value.type === "plan-structured" &&
    isPlanEntries(value.entries) &&
    (value.title === undefined || typeof value.title === "string")
  );
}

export function isRichTextPart(value: unknown): value is UIRichTextPart {
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

export function isImageArtifactPart(value: unknown): value is UIImagePart {
  return (
    isObject(value) &&
    value.type === "image" &&
    typeof value.image_url === "string"
  );
}

export function isPdfArtifactPart(value: unknown): value is UIPdfPart {
  return (
    isObject(value) &&
    value.type === "pdf" &&
    typeof value.pdf_url === "string" &&
    (value.filename === undefined || typeof value.filename === "string")
  );
}

export function isTextFileArtifactPart(
  value: unknown,
): value is UITextFilePart {
  return (
    isObject(value) &&
    value.type === "text-file" &&
    typeof value.file_url === "string" &&
    (value.filename === undefined || typeof value.filename === "string") &&
    (value.mime_type === undefined || typeof value.mime_type === "string")
  );
}

export function isPlanTextArtifactPart(value: unknown): value is UIPlanPart {
  return (
    isObject(value) &&
    value.type === "plan" &&
    typeof value.planText === "string" &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.taskCount === undefined || typeof value.taskCount === "number")
  );
}

export function isDelegationPart(value: unknown): value is DBDelegationMessage {
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

export function isTerragonDataPartName(
  value: unknown,
): value is TerragonDataPartName {
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
