const TOOL_ARG_PREVIEW_SCAN_LIMIT = 4096;
const STREAMING_TOOL_ARGS_RENDER_LIMIT = 2000;
const TOOL_PREVIEW_FIELDS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
] as const;

const jsonField = (value: unknown, key: string): string | null => {
  if (!value || typeof value !== "object" || !(key in value)) return null;
  const field = Object.entries(value).find(
    ([entryKey]) => entryKey === key,
  )?.[1];
  return typeof field === "string" && field.length > 0 ? field : null;
};

const parseJsonStringLiteral = (raw: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(`"${raw}"`);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
};

const quotedJsonField = (argsText: string, key: string): string | null => {
  const scanned = argsText.slice(0, TOOL_ARG_PREVIEW_SCAN_LIMIT);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)(?:"|$)`,
  ).exec(scanned);
  return match?.[1] ? parseJsonStringLiteral(match[1]) : null;
};

export const toolArgPreview = (argsText: string): string | null => {
  if (!argsText) return null;

  for (const key of TOOL_PREVIEW_FIELDS) {
    const field = quotedJsonField(argsText, key);
    if (field) return field;
  }

  try {
    const parsed: unknown = JSON.parse(argsText);
    return (
      jsonField(parsed, "command") ??
      jsonField(parsed, "file_path") ??
      jsonField(parsed, "path") ??
      jsonField(parsed, "pattern") ??
      jsonField(parsed, "query")
    );
  } catch {
    return argsText;
  }
};

export const toolArgsDisplayText = (
  argsText: string,
  active: boolean,
): string => {
  if (!active || argsText.length <= STREAMING_TOOL_ARGS_RENDER_LIMIT) {
    return argsText;
  }
  return `${argsText.slice(0, STREAMING_TOOL_ARGS_RENDER_LIMIT - 1)}…`;
};

export const toolCallResultText = (result: unknown): string => {
  if (typeof result === "string") return result;
  if (result === undefined) return "";
  return JSON.stringify(result, null, 2);
};

export type StreamingView = {
  readonly text: string;
  readonly streaming: boolean;
};

export type ToolCallState =
  | "pending"
  | "approval"
  | "running"
  | "success"
  | "error";

export const toolCallState = (
  active: boolean,
  failed: boolean,
): ToolCallState => (failed ? "error" : active ? "running" : "success");

export type ToolViewInput = {
  readonly toolName: string;
  readonly argsText: string;
  readonly result: unknown;
  readonly active: boolean;
  readonly failed: boolean;
};

export type ToolViewProps = {
  readonly name: string;
  readonly preview: string | null;
  readonly state: ToolCallState;
  readonly stream: StreamingView;
  readonly resultText: string;
  readonly errorText: string;
  readonly defaultOpen: boolean;
};

export const toolViewProps = (input: ToolViewInput): ToolViewProps => {
  const { toolName, argsText, result, active, failed } = input;
  const resultText = toolCallResultText(result);
  const state = toolCallState(active, failed);
  return {
    name: toolName,
    preview: toolArgPreview(argsText),
    state,
    stream: { text: toolArgsDisplayText(argsText, active), streaming: active },
    resultText,
    errorText: state === "error" ? resultText : "",
    defaultOpen: failed,
  };
};
