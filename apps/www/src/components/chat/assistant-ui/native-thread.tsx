"use client";

import {
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type ReasoningMessagePartComponent,
  type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { Check, ChevronDown, Copy, Link, Loader2, Wrench } from "lucide-react";
import { useCallback, useMemo, useState, type PropsWithChildren } from "react";
import { toast } from "sonner";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { TextPart } from "../text-part";

/**
 * Native transcript surface — pure assistant-ui. The runtime owns the message
 * list (`ThreadPrimitive.Messages`) and the part dispatch
 * (`MessagePrimitive.Parts`). Only the native AG-UI part types render: text
 * (via the streamdown markdown slot), reasoning, and tool calls. The bespoke
 * Terragon renderers (diff, terminal, plan, delegation, ...) are intentionally
 * not used here — the composer (TipTap) and markdown (streamdown) are the only
 * non-library pieces.
 */

const NativeText: TextMessagePartComponent = ({ text, status }) => (
  <TextPart text={text} streaming={status.type === "running"} />
);

const NativeReasoning: ReasoningMessagePartComponent = ({ text, status }) => (
  <details className="my-2 text-sm text-muted-foreground">
    <summary className="cursor-pointer select-none">Thinking</summary>
    <div className="mt-1 text-muted-foreground">
      <TextPart text={text} streaming={status.type === "running"} />
    </div>
  </details>
);

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

export const getToolGroupFlags = (
  parts: readonly ToolGroupPart[],
  startIndex: number,
  endIndex: number,
  onVisitPart?: () => void,
): number => {
  let count = 0;
  let flags = 0;

  for (let index = startIndex; index <= endIndex; index += 1) {
    onVisitPart?.();
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

const NativeToolGroup = ({
  startIndex,
  endIndex,
  children,
}: PropsWithChildren<{ startIndex: number; endIndex: number }>) => {
  const toolGroupFlags = useAuiState((state) =>
    getToolGroupFlags(state.message.parts, startIndex, endIndex),
  );
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const { count, hasActive, hasError } = decodeToolGroupFlags(toolGroupFlags);
  const open = hasActive || manualOpen === true;

  if (count <= 1) return <>{children}</>;

  return (
    <details
      className={cn(
        "group/tool-group my-2 rounded-md border border-border bg-surface-soft text-sm",
        hasError && "border-error/40 bg-error/5",
      )}
      open={open}
      onToggle={(event) => setManualOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-muted-foreground marker:content-['']">
        {hasActive ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <span className="font-medium text-foreground">
          Tool calls ({count})
        </span>
        <span className="ml-auto text-xs">
          {hasActive ? "Running" : hasError ? "Needs attention" : "Completed"}
        </span>
        <ChevronDown
          className="h-3.5 w-3.5 transition-transform group-open/tool-group:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-border/70 px-2 py-2">{children}</div>
    </details>
  );
};

const toolCallResultText = (result: unknown): string => {
  if (typeof result === "string") return result;
  if (result === undefined) return "";
  return JSON.stringify(result, null, 2);
};

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

const truncatePreview = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;

export const toolArgsDisplayText = (
  argsText: string,
  active: boolean,
): string => {
  if (!active || argsText.length <= STREAMING_TOOL_ARGS_RENDER_LIMIT) {
    return argsText;
  }
  return `${argsText.slice(0, STREAMING_TOOL_ARGS_RENDER_LIMIT - 1)}…`;
};

const NativeToolCall: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
  isError,
}) => {
  const active = status.type === "running" || result === undefined;
  const failed = isError === true || status.type === "incomplete";
  const resultText = useMemo(() => toolCallResultText(result), [result]);
  const preview = useMemo(() => toolArgPreview(argsText), [argsText]);
  const displayArgsText = useMemo(
    () => toolArgsDisplayText(argsText, active),
    [active, argsText],
  );
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = active || manualOpen === true;

  return (
    <details
      className={cn(
        "group/tool-call my-1 rounded-md border border-border bg-background text-sm",
        failed && "border-error/40 bg-error/5",
      )}
      open={open}
      onToggle={(event) => setManualOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 marker:content-['']">
        {active ? (
          <Loader2
            className="h-3.5 w-3.5 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <Wrench
            className="h-3.5 w-3.5 text-muted-foreground"
            aria-hidden="true"
          />
        )}
        <span className="font-mono text-xs text-muted-foreground">
          {toolName}
        </span>
        {preview ? (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {truncatePreview(preview, 120)}
          </span>
        ) : null}
        <span
          className={cn(
            "ml-auto text-xs",
            failed ? "text-error" : "text-muted-foreground",
          )}
        >
          {active ? "Running" : failed ? "Failed" : "Done"}
        </span>
        <ChevronDown
          className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open/tool-call:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-border/70 px-3 py-2">
        {displayArgsText ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
            {displayArgsText}
          </pre>
        ) : null}
        {resultText ? (
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {resultText}
          </pre>
        ) : null}
      </div>
    </details>
  );
};

const ASSISTANT_PART_COMPONENTS = {
  Text: NativeText,
  Reasoning: NativeReasoning,
  tools: { Override: NativeToolCall },
  ToolGroup: NativeToolGroup,
} as const;

type MessageContentPart = {
  readonly type: string;
  readonly text?: string;
};

const messageTextFromParts = (parts: readonly MessageContentPart[]): string =>
  parts
    .filter((part) => part.type === "text" || part.type === "reasoning")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();

const NATIVE_ACTION_BTN =
  "flex items-center justify-center min-h-[32px] min-w-[32px] px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded-md hover:opacity-70 transition-[opacity,color,scale] duration-150 active:scale-[0.98] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring";

const NativeMessageActions = ({ align }: { align: "start" | "end" }) => {
  const messageId = useAuiState((state) => state.message.id);
  const parts = useAuiState(
    (state) => state.message.parts as readonly MessageContentPart[],
  );
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const text = messageTextFromParts(parts);
    if (!text) return;
    try {
      await copyTextToClipboard(text);
      toast.success("Copied");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy message");
    }
  }, [parts]);

  const handleLink = useCallback(async () => {
    if (typeof window === "undefined") return;
    try {
      await copyTextToClipboard(
        `${window.location.origin}${window.location.pathname}#message-${messageId}`,
      );
      toast.success("Link copied");
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      toast.error("Failed to copy link");
    }
  }, [messageId]);

  const hasText = parts.some(
    (part) => part.type === "text" || part.type === "reasoning",
  );
  if (!hasText) return null;

  return (
    <div
      className={cn(
        "mt-1 flex min-h-[32px] gap-1.5 opacity-0 transition-opacity group-hover/native-msg:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100",
        align === "end" ? "justify-end" : "justify-start",
      )}
    >
      <button
        type="button"
        onClick={handleCopy}
        className={NATIVE_ACTION_BTN}
        title="Copy message"
        aria-label={copied ? "Message copied" : "Copy message"}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={handleLink}
        className={NATIVE_ACTION_BTN}
        title="Copy link to message"
        aria-label={linkCopied ? "Link copied" : "Copy link to message"}
      >
        {linkCopied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Link className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
};

const NativeUserMessage = () => (
  <MessagePrimitive.Root className="group/native-msg flex flex-col items-end py-2 [content-visibility:auto] [contain-intrinsic-size:auto_96px] animate-in fade-in slide-in-from-bottom-2 duration-[var(--duration-base)] ease-[var(--ease-emphasis)]">
    <div className="ml-auto w-fit max-w-[90%] rounded-[calc(var(--radius)+0.15rem)] bg-card px-4 py-3 text-card-foreground shadow-[var(--shadow-warm-lift)] sm:max-w-[85%]">
      <MessagePrimitive.Parts />
    </div>
    <NativeMessageActions align="end" />
  </MessagePrimitive.Root>
);

const NativeAssistantMessage = () => (
  <MessagePrimitive.Root className="group/native-msg flex flex-col py-2 [content-visibility:auto] [contain-intrinsic-size:auto_160px] animate-in fade-in duration-[var(--duration-quick)] ease-[var(--ease-emphasis)]">
    <div className="mr-auto w-full break-words text-sm leading-relaxed">
      <MessagePrimitive.Parts components={ASSISTANT_PART_COMPONENTS} />
    </div>
    <NativeMessageActions align="start" />
  </MessagePrimitive.Root>
);

/**
 * Native transcript MESSAGE LIST only. Rendered inside
 * `TerragonTranscriptSurface`, which owns the surrounding chrome (lifecycle
 * messages, the "Connecting to live task…" state, the boot checklist / working
 * footer, errors, scheduled state) and the scroll container — so this renders
 * no scroll viewport of its own to avoid a nested scroller.
 */
export function NativeThread() {
  return (
    <ThreadPrimitive.Root className="flex flex-col gap-4">
      <ThreadPrimitive.Messages
        components={{
          UserMessage: NativeUserMessage,
          AssistantMessage: NativeAssistantMessage,
        }}
      />
    </ThreadPrimitive.Root>
  );
}
