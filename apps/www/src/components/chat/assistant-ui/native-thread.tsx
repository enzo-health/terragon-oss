"use client";

import {
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type ReasoningMessagePartComponent,
  type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { ChevronDown, Loader2, Wrench } from "lucide-react";
import { useState, type PropsWithChildren } from "react";
import { MarkdownRenderer } from "@/components/ai-elements/markdown-renderer";
import { cn } from "@/lib/utils";

/**
 * Native transcript surface — pure assistant-ui. The runtime owns the message
 * list (`ThreadPrimitive.Messages`) and the part dispatch
 * (`MessagePrimitive.Parts`). Only the native AG-UI part types render: text
 * (via the streamdown markdown slot), reasoning, and tool calls. The bespoke
 * Terragon renderers (diff, terminal, plan, delegation, ...) are intentionally
 * not used here — the composer (TipTap) and markdown (streamdown) are the only
 * non-library pieces.
 */

const NativeText: TextMessagePartComponent = ({ text }) => (
  <MarkdownRenderer content={text} />
);

const NativeReasoning: ReasoningMessagePartComponent = ({ text }) => (
  <details className="my-2 text-sm text-muted-foreground">
    <summary className="cursor-pointer select-none">Thinking</summary>
    <div className="mt-1">
      <MarkdownRenderer content={text} variant="reasoning" />
    </div>
  </details>
);

type ToolGroupPart = {
  readonly type: string;
  readonly status?: { readonly type: string };
  readonly result?: unknown;
  readonly isError?: boolean;
};

const countToolParts = (
  parts: readonly ToolGroupPart[],
  startIndex: number,
  endIndex: number,
): number => {
  let count = 0;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const part = parts[index];
    if (!part || part.type !== "tool-call") continue;

    count += 1;
  }

  return count;
};

const toolGroupHasActiveCall = (
  parts: readonly ToolGroupPart[],
  startIndex: number,
  endIndex: number,
): boolean => {
  for (let index = startIndex; index <= endIndex; index += 1) {
    const part = parts[index];
    if (
      part?.type === "tool-call" &&
      (part.status?.type === "running" || part.result === undefined)
    ) {
      return true;
    }
  }

  return false;
};

const toolGroupHasError = (
  parts: readonly ToolGroupPart[],
  startIndex: number,
  endIndex: number,
): boolean => {
  for (let index = startIndex; index <= endIndex; index += 1) {
    const part = parts[index];
    if (
      part?.type === "tool-call" &&
      (part.isError === true || part.status?.type === "incomplete")
    ) {
      return true;
    }
  }

  return false;
};

const NativeToolGroup = ({
  startIndex,
  endIndex,
  children,
}: PropsWithChildren<{ startIndex: number; endIndex: number }>) => {
  const count = useAuiState((state) =>
    countToolParts(state.message.parts, startIndex, endIndex),
  );
  const hasActive = useAuiState((state) =>
    toolGroupHasActiveCall(state.message.parts, startIndex, endIndex),
  );
  const hasError = useAuiState((state) =>
    toolGroupHasError(state.message.parts, startIndex, endIndex),
  );
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = hasActive || hasError || manualOpen === true;

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

const jsonField = (value: unknown, key: string): string | null => {
  if (!value || typeof value !== "object" || !(key in value)) return null;
  const field = Object.entries(value).find(
    ([entryKey]) => entryKey === key,
  )?.[1];
  return typeof field === "string" && field.length > 0 ? field : null;
};

const toolArgPreview = (argsText: string): string | null => {
  if (!argsText) return null;

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

const NativeToolCall: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
  isError,
}) => {
  const active = status.type === "running" || result === undefined;
  const failed = isError === true || status.type === "incomplete";
  const resultText = toolCallResultText(result);
  const preview = toolArgPreview(argsText);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = active || failed || manualOpen === true;

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
        {argsText ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
            {argsText}
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

const NativeUserMessage = () => (
  <MessagePrimitive.Root className="flex flex-col items-end py-2">
    <div className="ml-auto w-fit max-w-[90%] rounded-[calc(var(--radius)+0.15rem)] bg-card px-4 py-3 text-card-foreground shadow-[var(--shadow-warm-lift)] sm:max-w-[85%]">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
);

const NativeAssistantMessage = () => (
  <MessagePrimitive.Root className="flex flex-col py-2">
    <div className="mr-auto w-full break-words text-sm leading-relaxed">
      <MessagePrimitive.Parts components={ASSISTANT_PART_COMPONENTS} />
    </div>
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
