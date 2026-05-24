import { getField } from "./ag-ui-reducer-utils";
import type { UIPartExtended } from "./ui-parts-extended";

export function isRenderablePart(value: unknown): value is UIPartExtended {
  if (!value || typeof value !== "object") return false;
  const type = getField<string>(value, "type");
  switch (type) {
    case "text":
      return typeof getField<unknown>(value, "text") === "string";
    case "thinking":
      return typeof getField<unknown>(value, "thinking") === "string";
    case "image":
      return typeof getField<unknown>(value, "image_url") === "string";
    case "rich-text":
      return Array.isArray(getField<unknown>(value, "nodes"));
    case "pdf":
      return typeof getField<unknown>(value, "pdf_url") === "string";
    case "text-file":
      return typeof getField<unknown>(value, "file_url") === "string";
    case "plan":
      return (
        typeof getField<unknown>(value, "planText") === "string" ||
        (Array.isArray(getField<unknown>(value, "entries")) &&
          (getField<unknown>(value, "entries") as unknown[]).every(
            isValidPlanEntryShape,
          ))
      );
    case "tool":
      return (
        typeof getField<unknown>(value, "id") === "string" &&
        typeof getField<unknown>(value, "name") === "string" &&
        Array.isArray(getField<unknown>(value, "parts"))
      );
    case "delegation":
      return (
        typeof getField<unknown>(value, "id") === "string" &&
        typeof getField<unknown>(value, "agentName") === "string" &&
        typeof getField<unknown>(value, "message") === "string" &&
        typeof getField<unknown>(value, "status") === "string"
      );
    case "audio":
    case "resource-link":
    case "terminal":
    case "diff":
    case "auto-approval-review":
    case "plan-structured":
    case "server-tool-use":
    case "web-search-result":
      return true;
    default:
      const _exhaustiveCheck = type satisfies string | undefined;
      void _exhaustiveCheck;
      return false;
  }
}

function isValidPlanEntryShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const content = getField<unknown>(value, "content");
  const priority = getField<unknown>(value, "priority");
  const status = getField<unknown>(value, "status");
  return (
    typeof content === "string" &&
    (priority === "high" || priority === "medium" || priority === "low") &&
    (status === "pending" ||
      status === "in_progress" ||
      status === "completed" ||
      status === "failed")
  );
}

export function normalizeRenderablePart(part: UIPartExtended): UIPartExtended {
  if (
    part.type === "plan" &&
    "entries" in part &&
    Array.isArray(part.entries)
  ) {
    return {
      type: "plan-structured",
      entries: part.entries,
    };
  }
  return part;
}

export function getPartIdentity(part: UIPartExtended): {
  type: string;
  id: string | null;
} {
  const id = getField<unknown>(part, "id");
  return {
    type: part.type,
    id: typeof id === "string" ? id : null,
  };
}
