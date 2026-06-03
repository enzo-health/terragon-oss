"use client";

import {
  type DataMessagePartComponent,
  MessagePrimitive,
  type ReasoningMessagePartComponent,
  type TextMessagePartComponent,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react";
import { AlertCircle, Check, Copy, Link, Wrench } from "lucide-react";
import { type PropsWithChildren, useState } from "react";
import { toast } from "sonner";
import { Callout, CalloutContent, CalloutIcon } from "@/components/ai/callout";
import {
  Message,
  MessageAction,
  MessageContent,
  MessageText,
} from "@/components/ai/message";
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
  getToolGroupFlags,
  reasoningViewProps,
  toolGroupViewPropsFromFlags,
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
  <MessageText variant="plain">
    <TextPart text={text} streaming={status.type === "running"} />
  </MessageText>
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
  const flags = useAuiState((s) =>
    getToolGroupFlags(s.message.parts, startIndex, endIndex),
  );
  const { count, state, statusLabel, defaultOpen } =
    toolGroupViewPropsFromFlags(flags);
  const [open, setOpen] = useState(defaultOpen);

  if (count <= 1) return <>{children}</>;

  return (
    <Tool className="my-2" state={state} open={open} onOpenChange={setOpen}>
      <ToolTrigger>
        <ToolIcon>
          <Wrench />
        </ToolIcon>
        <ToolName>Tool calls ({count})</ToolName>
        <ToolLabel>{statusLabel}</ToolLabel>
      </ToolTrigger>
      <ToolContent>{children}</ToolContent>
    </Tool>
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
      <ToolContent keepMounted>
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

/**
 * Inline item-level error (e.g. a Codex `error` item → `DBErrorPart`). On the
 * live AG-UI path this arrives as a `terragon.error` data part, so it renders
 * through `MessagePrimitive.Parts`'s `data.by_name` slot rather than the
 * legacy part registry. Falls back to the data part's raw `message`/value when
 * the typed payload is missing.
 */
const NativeError: DataMessagePartComponent = ({ data }) => {
  const message =
    data &&
    typeof data === "object" &&
    typeof Reflect.get(data, "message") === "string"
      ? (Reflect.get(data, "message") as string)
      : typeof data === "string"
        ? data
        : "An error occurred.";

  return (
    <Callout className="my-2" tone="danger" role="alert">
      <CalloutIcon>
        <AlertCircle />
      </CalloutIcon>
      <CalloutContent>{message}</CalloutContent>
    </Callout>
  );
};

const ASSISTANT_PART_COMPONENTS = {
  Text: NativeText,
  Reasoning: NativeReasoning,
  tools: { Override: NativeToolCall },
  ToolGroup: NativeToolGroup,
  data: { by_name: { "terragon.error": NativeError } },
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
    <MessageAction
      className={cn(
        "mt-1 min-h-[32px] gap-1.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100",
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
    </MessageAction>
  );
};

const NativeUserMessage = () => (
  <MessagePrimitive.Root className="py-2 [content-visibility:auto] [contain-intrinsic-size:auto_96px] animate-in fade-in slide-in-from-bottom-2 duration-[var(--duration-base)] ease-[var(--ease-emphasis)]">
    <Message type="outgoing">
      <MessageContent>
        <MessageText
          variant="bubble"
          className="max-w-[90%] rounded-[calc(var(--radius)+0.15rem)] bg-card px-4 py-3 text-card-foreground shadow-[var(--shadow-warm-lift)] ring-0 sm:max-w-[85%]"
        >
          <MessagePrimitive.Parts />
        </MessageText>
        <NativeMessageActions align="end" />
      </MessageContent>
    </Message>
  </MessagePrimitive.Root>
);

const NativeAssistantMessage = () => (
  <MessagePrimitive.Root className="py-2 [content-visibility:auto] [contain-intrinsic-size:auto_160px] animate-in fade-in duration-[var(--duration-quick)] ease-[var(--ease-emphasis)]">
    <Message type="incoming">
      <MessageContent className="break-words text-sm leading-relaxed">
        <MessagePrimitive.Parts components={ASSISTANT_PART_COMPONENTS} />
        <NativeMessageActions align="start" />
      </MessageContent>
    </Message>
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
