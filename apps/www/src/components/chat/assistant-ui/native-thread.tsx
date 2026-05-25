"use client";

import {
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type ThreadAssistantMessagePart,
  type ThreadUserMessagePart,
} from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import type { UIPart } from "@terragon/shared";
import { MessagePart } from "../message-part";
import {
  assistantPartToUIPart,
  userPartToUIPart,
} from "./runtime-part-conversion";
import { useTerragonMessageRender } from "./thread-context";

/**
 * Native transcript surface (Phase N1 of the native-first strip — see
 * `docs/plans/2026-05-25-native-first-strip-and-rebuild.md`). The assistant-ui
 * runtime owns the message list (`ThreadPrimitive.Messages`); the projector,
 * view-model reducer, and coalescing band are out of this path.
 *
 * Part rendering reuses the existing `MessagePart` registry via the proven
 * `assistantPartToUIPart` / `userPartToUIPart` converters, so EVERY runtime
 * part type renders losslessly (text, reasoning, tool calls, and the rich
 * `data` parts: terminal, plan, delegation, image, audio, ...). Migrating
 * individual parts to native renderers is N4; until then this stays lossless
 * rather than dropping unsupported parts.
 */

function NativeMessageParts({ agent }: { agent: AIAgent }) {
  const role = useAuiState((state) => state.message.role);
  const content = useAuiState((state) => state.message.content);
  const ctx = useTerragonMessageRender();

  const parts: UIPart[] = [];
  for (const part of content) {
    const converted =
      role === "user"
        ? userPartToUIPart(part as ThreadUserMessagePart)
        : assistantPartToUIPart(part as ThreadAssistantMessagePart, agent);
    if (converted) {
      parts.push(converted as UIPart);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      {parts.map((part, index) => (
        <MessagePart
          key={index}
          part={part}
          isLatest={false}
          isAgentWorking={false}
          githubRepoFullName={ctx.messagePartProps.githubRepoFullName}
          branchName={ctx.messagePartProps.branchName}
          baseBranchName={ctx.messagePartProps.baseBranchName}
          hasCheckpoint={ctx.messagePartProps.hasCheckpoint}
          toolProps={ctx.messagePartProps.toolProps}
          artifactDescriptors={ctx.artifactDescriptors}
          artifactDescriptorLookup={ctx.artifactDescriptorLookup}
          onOpenArtifact={ctx.onOpenArtifact}
          onOpenRepoFile={ctx.onOpenRepoFile}
          planOccurrenceIndex={ctx.planOccurrences.get(part)}
        />
      ))}
    </div>
  );
}

export function NativeThread({ agent }: { agent: AIAgent }) {
  const NativeUserMessage = () => (
    <MessagePrimitive.Root className="flex flex-col items-end py-2">
      <div className="ml-auto w-fit max-w-[90%] rounded-[calc(var(--radius)+0.15rem)] bg-card px-4 py-3 text-card-foreground shadow-[var(--shadow-warm-lift)] sm:max-w-[85%]">
        <NativeMessageParts agent={agent} />
      </div>
    </MessagePrimitive.Root>
  );

  const NativeAssistantMessage = () => (
    <MessagePrimitive.Root className="flex flex-col py-2">
      <div className="mr-auto w-full break-words">
        <NativeMessageParts agent={agent} />
      </div>
    </MessagePrimitive.Root>
  );

  return (
    <ThreadPrimitive.Root className="flex h-full flex-col">
      <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-chat flex-col gap-6 py-6">
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
