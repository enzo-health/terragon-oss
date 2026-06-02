"use client";

import {
  MessagePrimitive,
  type ReasoningMessagePartComponent,
  type TextMessagePartComponent,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react";
import { Check, ChevronDown, Copy, Link, Loader2, Wrench } from "lucide-react";
import { type PropsWithChildren, type SyntheticEvent, useState } from "react";
import { toast } from "sonner";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai/reasoning";
import {
  Tool,
  ToolArgument,
  ToolBlock,
  ToolContent,
  ToolError,
  ToolIcon,
  ToolLabel,
  ToolName,
  ToolTrigger,
} from "@/components/ai/tool";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { TextPart } from "../text-part";
import {
  decodeToolGroupFlags,
  getToolGroupFlags,
  reasoningViewProps,
  toolViewProps,
} from "./native-thread-utils";

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

const NativeReasoning: ReasoningMessagePartComponent = ({ text, status }) => {
  const { body, streaming, label } = reasoningViewProps(text, status);
  const [open, setOpen] = useState(streaming);

  return (
    <Reasoning className="my-2" open={open} onOpenChange={setOpen}>
      <ReasoningTrigger>{label}</ReasoningTrigger>
      <ReasoningContent keepMounted>
        <TextPart text={body} streaming={streaming} />
      </ReasoningContent>
    </Reasoning>
  );
};

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
  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    setManualOpen(event.currentTarget.open);
  };

  if (count <= 1) return <>{children}</>;

  return (
    <details
      className={cn(
        "group/tool-group my-2 rounded-md border border-border bg-surface-soft text-sm",
        hasError && "border-error/40 bg-error/5",
      )}
      open={open}
      onToggle={handleToggle}
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-muted-foreground marker:content-['']">
        {hasActive ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Wrench className="size-3.5" aria-hidden="true" />
        )}
        <span className="font-medium text-foreground">
          Tool calls ({count})
        </span>
        <span className="ml-auto text-xs">
          {hasActive ? "Running" : hasError ? "Needs attention" : "Completed"}
        </span>
        <ChevronDown
          className="size-3.5 transition-transform group-open/tool-group:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-border/70 p-2">{children}</div>
    </details>
  );
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
  const { name, preview, state, stream, resultText, errorText, defaultOpen } =
    toolViewProps({ toolName, argsText, result, active, failed });
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Tool className="my-1" state={state} open={open} onOpenChange={setOpen}>
      <ToolTrigger>
        <ToolIcon>
          <Wrench />
        </ToolIcon>
        <ToolName>{name}</ToolName>
        {preview ? <ToolLabel>{preview}</ToolLabel> : null}
      </ToolTrigger>
      <ToolContent>
        {stream.text ? (
          <ToolArgument
            value={stream.text}
            state={stream.streaming ? "streaming" : "complete"}
          />
        ) : null}
        {resultText ? <ToolBlock>{resultText}</ToolBlock> : null}
        {errorText ? <ToolError>{errorText}</ToolError> : null}
      </ToolContent>
    </Tool>
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

const messageTextFromParts = (parts: readonly MessageContentPart[]): string => {
  const textParts: string[] = [];
  for (const part of parts) {
    if (part.type === "text" || part.type === "reasoning") {
      textParts.push(part.text ?? "");
    }
  }
  return textParts.join("\n").trim();
};

const NATIVE_ACTION_BTN =
  "flex items-center justify-center min-h-[32px] min-w-[32px] px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded-md hover:opacity-70 transition-[opacity,color,scale] duration-150 active:scale-[0.98] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring";

const NativeMessageActions = ({ align }: { align: "start" | "end" }) => {
  const messageId = useAuiState((state) => state.message.id);
  const parts = useAuiState(
    (state) => state.message.parts as readonly MessageContentPart[],
  );
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const copyMessage = async () => {
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
  };

  const copyMessageLink = async () => {
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
  };

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
        onClick={copyMessage}
        className={NATIVE_ACTION_BTN}
        title="Copy message"
        aria-label={copied ? "Message copied" : "Copy message"}
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={copyMessageLink}
        className={NATIVE_ACTION_BTN}
        title="Copy link to message"
        aria-label={linkCopied ? "Link copied" : "Copy link to message"}
      >
        {linkCopied ? (
          <Check className="size-3.5" />
        ) : (
          <Link className="size-3.5" />
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

const NATIVE_MESSAGE_COMPONENTS = {
  UserMessage: NativeUserMessage,
  AssistantMessage: NativeAssistantMessage,
} as const;

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
      <ThreadPrimitive.Messages components={NATIVE_MESSAGE_COMPONENTS} />
    </ThreadPrimitive.Root>
  );
}
