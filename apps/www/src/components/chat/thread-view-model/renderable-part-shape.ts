import type { ThreadStatus } from "@terragon/shared";

export function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${stableSerialize(entryValue)}`,
    )
    .join(",")}}`;
}

export function getObjectField(
  value: unknown,
  field: string,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = Reflect.get(value, field);
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? Object.fromEntries(Object.entries(candidate))
    : null;
}

export function getStringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = Reflect.get(value, field);
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

export function getJsonPointerPathField(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = Reflect.get(value, "path");
  return typeof candidate === "string" ? candidate : null;
}

export function getArrayField(value: unknown, field: string): unknown[] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = Reflect.get(value, field);
  return Array.isArray(candidate) ? candidate : null;
}

export function getBooleanField(value: unknown, field: string): boolean | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = Reflect.get(value, field);
  return typeof candidate === "boolean" ? candidate : null;
}

export function getNumberField(value: unknown, field: string): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = Reflect.get(value, field);
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : null;
}

export function isRenderablePartShape(
  value: Readonly<Record<string, unknown>>,
): boolean {
  const type = getStringField(value, "type");
  switch (type) {
    case "text":
      return typeof value.text === "string";
    case "thinking":
      return typeof value.thinking === "string";
    case "image":
      return typeof value.image_url === "string";
    case "rich-text":
      return Array.isArray(value.nodes);
    case "pdf":
      return typeof value.pdf_url === "string";
    case "text-file":
      return typeof value.file_url === "string";
    case "plan":
      return (
        typeof value.planText === "string" ||
        (Array.isArray(value.entries) &&
          value.entries.every(isRenderablePlanEntry))
      );
    case "tool":
      return (
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        Array.isArray(value.parts)
      );
    case "delegation":
      return (
        typeof value.id === "string" &&
        typeof value.agentName === "string" &&
        typeof value.message === "string" &&
        typeof value.status === "string"
      );
    case "audio":
      return typeof value.mimeType === "string";
    case "resource-link":
      return typeof value.uri === "string" && typeof value.name === "string";
    case "terminal":
      return (
        typeof value.sandboxId === "string" &&
        typeof value.terminalId === "string" &&
        Array.isArray(value.chunks) &&
        value.chunks.every(isRenderableTerminalChunk)
      );
    case "diff":
      return (
        (value.filePath === undefined || typeof value.filePath === "string") &&
        (typeof value.newContent === "string" ||
          typeof value.unifiedDiff === "string" ||
          typeof value.diff === "string") &&
        (value.status === undefined ||
          isDiffStatus(getStringField(value, "status")))
      );
    case "auto-approval-review":
      return (
        typeof value.reviewId === "string" &&
        typeof value.targetItemId === "string" &&
        typeof value.action === "string" &&
        isRiskLevel(getStringField(value, "riskLevel")) &&
        isAutoApprovalReviewStatus(getStringField(value, "status"))
      );
    case "plan-structured":
      return (
        Array.isArray(value.entries) &&
        value.entries.every(isRenderablePlanEntry)
      );
    case "server-tool-use":
      return (
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        value.input !== null &&
        typeof value.input === "object" &&
        !Array.isArray(value.input)
      );
    case "web-search-result":
      return (
        typeof value.toolUseId === "string" &&
        (value.results === undefined ||
          (Array.isArray(value.results) &&
            value.results.every(isRenderableWebSearchResult))) &&
        (value.errorCode === undefined || typeof value.errorCode === "string")
      );
    default:
      const _exhaustiveCheck = type satisfies string | null;
      void _exhaustiveCheck;
      return false;
  }
}

function isRenderableTerminalChunk(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (
    typeof Reflect.get(value, "streamSeq") === "number" &&
    Number.isInteger(Reflect.get(value, "streamSeq")) &&
    (Reflect.get(value, "kind") === "stdout" ||
      Reflect.get(value, "kind") === "stderr" ||
      Reflect.get(value, "kind") === "interaction") &&
    typeof Reflect.get(value, "text") === "string"
  );
}

function isDiffStatus(value: string | null): boolean {
  return value === "pending" || value === "applied" || value === "rejected";
}

function isRiskLevel(value: string | null): boolean {
  return value === "low" || value === "medium" || value === "high";
}

function isAutoApprovalReviewStatus(value: string | null): boolean {
  return value === "pending" || value === "approved" || value === "denied";
}

function isRenderablePlanEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const priority = Reflect.get(value, "priority");
  const status = Reflect.get(value, "status");
  return (
    typeof Reflect.get(value, "content") === "string" &&
    (priority === "high" || priority === "medium" || priority === "low") &&
    (status === "pending" ||
      status === "in_progress" ||
      status === "completed" ||
      status === "failed")
  );
}

function isRenderableWebSearchResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (
    typeof Reflect.get(value, "url") === "string" &&
    typeof Reflect.get(value, "title") === "string" &&
    (Reflect.get(value, "pageAge") === undefined ||
      typeof Reflect.get(value, "pageAge") === "string") &&
    (Reflect.get(value, "encryptedContent") === undefined ||
      typeof Reflect.get(value, "encryptedContent") === "string")
  );
}

export function isThreadStatus(value: string | null): value is ThreadStatus {
  switch (value) {
    case "draft":
    case "scheduled":
    case "queued":
    case "queued-blocked":
    case "queued-tasks-concurrency":
    case "queued-sandbox-creation-rate-limit":
    case "queued-agent-rate-limit":
    case "booting":
    case "working":
    case "stopping":
    case "checkpointing":
    case "working-stopped":
    case "working-error":
    case "working-done":
    case "stopped":
    case "complete":
    case "error":
      return true;
    default:
      const _exhaustiveCheck = value satisfies string | null;
      void _exhaustiveCheck;
      return false;
  }
}
