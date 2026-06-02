/**
 * View-props adapter for the native transcript leaves. Every value a nauval
 * leaf needs is computed here as a plain string/boolean/number; leaves receive
 * only these, never a runtime part. Keep these functions stateless — stateful
 * streaming detection (refs, append fast-path) stays in `TextPart`, not here.
 */

type ToolGroupPart = {
  readonly type: string;
  readonly status?: { readonly type: string };
  readonly result?: unknown;
  readonly isError?: boolean;
};

type ToolGroupState = {
  count: number;
  hasActive: boolean;
  hasError: boolean;
};

const TOOL_GROUP_FLAG_HAS_ACTIVE = 1;
const TOOL_GROUP_FLAG_HAS_ERROR = 2;
const TOOL_GROUP_COUNT_SHIFT = 2;
const TOOL_ARG_PREVIEW_SCAN_LIMIT = 4096;
const STREAMING_TOOL_ARGS_RENDER_LIMIT = 2000;
const TOOL_PREVIEW_FIELDS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
] as const;

export const getToolGroupFlags = (
  parts: readonly ToolGroupPart[],
  startIndex: number,
  endIndex: number,
): number => {
  let count = 0;
  let flags = 0;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const part = parts[index];
    if (!part || part.type !== "tool-call") continue;

    count += 1;
    if (part.status?.type === "running" || part.result === undefined) {
      flags |= TOOL_GROUP_FLAG_HAS_ACTIVE;
    }
    if (part.isError === true || part.status?.type === "incomplete") {
      flags |= TOOL_GROUP_FLAG_HAS_ERROR;
    }
  }

  return (count << TOOL_GROUP_COUNT_SHIFT) | flags;
};

export function decodeToolGroupFlags(flags: number): ToolGroupState {
  return {
    count: flags >> TOOL_GROUP_COUNT_SHIFT,
    hasActive: (flags & TOOL_GROUP_FLAG_HAS_ACTIVE) !== 0,
    hasError: (flags & TOOL_GROUP_FLAG_HAS_ERROR) !== 0,
  };
}

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

type ReasoningStatus = { readonly type: string };

export type ReasoningViewProps = {
  readonly body: string;
  readonly streaming: boolean;
  readonly label: string;
};

/**
 * Plain view props for the reasoning leaf. `streaming` mirrors the runtime
 * "running" status so the nauval `Reasoning` shell stays a pure renderer; the
 * leaf passes these down and never sees the runtime part itself.
 */
export const reasoningViewProps = (
  text: string,
  status: ReasoningStatus,
): ReasoningViewProps => ({
  body: text,
  streaming: status.type === "running",
  label: "Thinking",
});

/**
 * One streaming shape for every nauval leaf: the text to render plus whether
 * the runtime is still pushing tokens into it. `streaming` is the pulse only;
 * lifecycle state (`toolCallState`) is tracked separately and never merged in.
 */
export type StreamingView = {
  readonly text: string;
  readonly streaming: boolean;
};

export const streamingView = (
  text: string,
  status: { readonly type: string },
): StreamingView => ({ text, streaming: status.type === "running" });

/**
 * Tool lifecycle state, separate from the streaming pulse. `pending`/`approval`
 * are reserved for future use by the nauval `Tool` shell; the adapter only ever
 * derives the three states a runtime tool part can actually be in.
 */
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

/**
 * Plain view props for one tool-call leaf. Composes the existing arg/result
 * adapters so the nauval `Tool` shell never sees the runtime part. `errorText`
 * falls back to the raw args when a failed call produced no result body.
 */
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
    errorText: state === "error" ? resultText || argsText : "",
    defaultOpen: active,
  };
};

export type ToolGroupViewProps = {
  readonly count: number;
  readonly state: "running" | "error" | "success";
  readonly statusLabel: string;
  readonly defaultOpen: boolean;
};

/**
 * Plain view props for a grouped tool-call header. Reuses the bit-packed
 * `getToolGroupFlags`/`decodeToolGroupFlags` so the reactive selector over
 * sibling parts stays inside the leaf and only the decoded view crosses out.
 */
export const toolGroupViewProps = (
  parts: readonly ToolGroupPart[],
  startIndex: number,
  endIndex: number,
): ToolGroupViewProps => {
  const { count, hasActive, hasError } = decodeToolGroupFlags(
    getToolGroupFlags(parts, startIndex, endIndex),
  );
  const state = hasActive ? "running" : hasError ? "error" : "success";
  const statusLabel = hasActive
    ? "Running"
    : hasError
      ? "Needs attention"
      : "Completed";
  return { count, state, statusLabel, defaultOpen: hasActive };
};
