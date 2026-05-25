"use client";

import {
  MessagePrimitive,
  ThreadPrimitive,
  type ReasoningMessagePartComponent,
  type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { MarkdownRenderer } from "@/components/ai-elements/markdown-renderer";

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

const NativeToolCall: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
}) => {
  const resultText =
    typeof result === "string"
      ? result
      : result === undefined
        ? ""
        : JSON.stringify(result, null, 2);
  return (
    <div className="my-2 rounded-md border border-border bg-surface-soft px-3 py-2 text-sm">
      <div className="font-mono text-xs text-muted-foreground">{toolName}</div>
      {argsText ? (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-xs">
          {argsText}
        </pre>
      ) : null}
      {resultText ? (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {resultText}
        </pre>
      ) : null}
    </div>
  );
};

const ASSISTANT_PART_COMPONENTS = {
  Text: NativeText,
  Reasoning: NativeReasoning,
  tools: { Override: NativeToolCall },
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

export function NativeThread() {
  return (
    <ThreadPrimitive.Root className="flex h-full flex-col">
      <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-chat flex-col gap-4 py-6">
          <ThreadPrimitive.Messages
            components={{
              UserMessage: NativeUserMessage,
              AssistantMessage: NativeAssistantMessage,
            }}
          />
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
