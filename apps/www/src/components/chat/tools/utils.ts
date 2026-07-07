import { AllToolParts } from "@terragon/shared";
import Convert from "ansi-to-html";
import { getAnsiColors } from "@/lib/ansi-colors";

export type TextLinePreview = {
  lineCount: number;
  previewLines: string[];
  remainingLines: number;
};

/**
 * Converts ANSI escape codes to HTML
 */
export function ansiToHtml(text: string, theme: "light" | "dark"): string {
  const convert = new Convert({
    fg: "var(--on-dark)",
    bg: "var(--base)",
    newline: false,
    escapeXML: true,
    stream: false,
    colors: getAnsiColors(theme),
  });
  return convert.toHtml(text);
}

/**
 * Maps known tool names to action verbs shown in the in-progress tool chip
 * in place of a generic "Working...". Verbs are written in their -ing form;
 * `getToolVerb` toggles the suffix based on status. Keep this list in sync
 * with `apps/www/src/components/chat/tools/*-tool.tsx` renderers.
 */
const TOOL_VERB_BY_NAME: Record<string, string> = {
  Bash: "Running",
  Read: "Reading",
  Write: "Writing",
  Edit: "Editing",
  MultiEdit: "Editing",
  Grep: "Searching",
  Glob: "Matching",
  LS: "Listing",
  WebFetch: "Fetching",
  WebSearch: "Searching",
  Task: "Delegating",
  TodoRead: "Reading todos",
  TodoWrite: "Updating todos",
  NotebookRead: "Reading notebook",
  NotebookEdit: "Editing notebook",
  FileChange: "Editing",
  ExitPlanMode: "Planning",
  PermissionRequest: "Awaiting approval",
  SuggestFollowupTask: "Suggesting follow-up",
};

/**
 * Returns a human-readable verb describing a tool's current state. Falls
 * back to "Running"/"Done" when no specific verb is configured so that new
 * or MCP-delegated tools render something sensible without plumbing.
 */
const COMPLETED_VERB_BY_VERB: Record<string, string> = {
  Running: "Ran",
  Reading: "Read",
  Writing: "Wrote",
  Editing: "Edited",
  Searching: "Searched",
  Matching: "Matched",
  Listing: "Listed",
  Fetching: "Fetched",
  Delegating: "Delegated",
};

export function getToolVerb(
  toolName: string,
  status: "pending" | "completed" | "error",
): string {
  const base = TOOL_VERB_BY_NAME[toolName];
  if (status === "pending") {
    return `${base ?? "Running"}...`;
  }
  if (!base) return "Done";
  return COMPLETED_VERB_BY_VERB[base] ?? "Done";
}

/**
 * Summarizes a tool result string for the collapsed preview row. For JSON
 * payloads we render a compact field count (e.g. `JSON result (5 fields)`)
 * so the user can expand to see the raw structure on demand, mirroring
 * Cline's expand-toggle pattern. For plaintext we fall back to the literal
 * first line. Empty strings produce "Done".
 */
export function summarizeToolResult(result: string): string {
  const trimmed = result.trim();
  if (!trimmed) return "Done";
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return `JSON result (${parsed.length} item${parsed.length === 1 ? "" : "s"})`;
      }
      if (parsed && typeof parsed === "object") {
        const keys = Object.keys(parsed);
        return `JSON result (${keys.length} field${keys.length === 1 ? "" : "s"})`;
      }
    } catch {
      // fallthrough to plaintext preview
    }
  }
  const firstLine = trimmed.split("\n", 1)[0] ?? "";
  if (firstLine.length <= 100) return firstLine || "Done";
  return firstLine.slice(0, 100) + "…";
}

export function createTextLinePreview(
  text: string,
  maxPreviewLines: number,
): TextLinePreview {
  if (text.length === 0) {
    return { lineCount: 0, previewLines: [], remainingLines: 0 };
  }

  let lineCount = 1;
  let lineStart = 0;
  const previewLines: string[] = [];

  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    if (previewLines.length < maxPreviewLines) {
      previewLines.push(text.slice(lineStart, index));
    }
    lineCount += 1;
    lineStart = index + 1;
  }

  if (previewLines.length < maxPreviewLines) {
    previewLines.push(text.slice(lineStart));
  }

  return {
    lineCount,
    previewLines,
    remainingLines: Math.max(0, lineCount - previewLines.length),
  };
}

export function countTextLines(text: string): number {
  return createTextLinePreview(text, 0).lineCount;
}

export function splitFirstLine(text: string): {
  firstLine: string;
  rest: string;
} {
  const newlineIndex = text.indexOf("\n");
  if (newlineIndex === -1) {
    return { firstLine: text, rest: "" };
  }
  return {
    firstLine: text.slice(0, newlineIndex),
    rest: text.slice(newlineIndex + 1),
  };
}

export function formatToolParameters(
  parameters: AllToolParts["parameters"],
  options: {
    includeKeys?: string[];
    excludeKeys?: string[];
    keyOrder?: string[];
  } = {},
) {
  const entries = Object.entries(parameters).filter(([key]) => {
    if (options.includeKeys) {
      return options.includeKeys.includes(key);
    }
    if (options.excludeKeys) {
      return !options.excludeKeys.includes(key);
    }
    return true;
  });
  if (entries.length === 1) {
    const value = entries[0]![1];
    if (typeof value === "string") {
      return value;
    }
    return JSON.stringify(value);
  }
  return entries
    .sort((a, b) => {
      const aIndex = options.keyOrder?.indexOf(a[0]) ?? -1;
      const bIndex = options.keyOrder?.indexOf(b[0]) ?? -1;
      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }
      if (aIndex !== -1) {
        return -1;
      }
      if (bIndex !== -1) {
        return 1;
      }
      return 0;
    })
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(", ");
}
