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
 * Native transcript surface (Phase N1 of the native-first strip — see
 * `docs/plans/2026-05-25-native-first-strip-and-rebuild.md`). Renders directly
 * from assistant-ui primitives reading the AG-UI runtime, with no Terragon
 * projector, view-model reducer, coalescing, or per-part custom renderers.
 *
 * Kept leaf-renderer divergences (decided): text/reasoning render through the
 * streamdown `MarkdownRenderer`; the composer stays TipTap and is rendered by
 * the existing prompt box outside this surface, not `ComposerPrimitive`.
 *
 * Rich parts (diff/terminal/plan/...) render through the single generic tool UI
 * below until they are re-added as native `ActivityMessage` renderers (Phase
 * N4). Gated behind the `nativeChatTranscript` flag; default off.
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

const NativeUserMessage = () => (
  <MessagePrimitive.Root className="flex flex-col items-end gap-1 py-2">
    <div className="max-w-chat rounded-2xl bg-surface-soft px-4 py-2">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
);

const NativeAssistantMessage = () => (
  <MessagePrimitive.Root className="flex flex-col gap-1 py-2">
    <MessagePrimitive.Parts
      components={{
        Text: NativeText,
        Reasoning: NativeReasoning,
        tools: { Override: NativeToolCall },
      }}
    />
  </MessagePrimitive.Root>
);

export function NativeThread() {
  return (
    <ThreadPrimitive.Root className="flex h-full flex-col">
      <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto w-full max-w-chat">
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
