"use client";

import type { UIMessage, UIPart } from "@terragon/shared";
import { memo } from "react";
import { cn } from "@/lib/utils";
import { AgentMetaFooter } from "../chat-message-agent-meta-footer";
import { MessageToolbar } from "../chat-message-toolbar";
import { MessagePart } from "../message-part";
import { TerragonSystemMessage } from "./system-message";
import {
  type TerragonMessageRenderContext,
  useTerragonMessageRender,
} from "./thread-context";
import { useStablePrefix } from "./use-stable-prefix";

type RuntimeTerragonMessageProps = {
  message: UIMessage;
  messageIndex: number;
  isLatestMessage: boolean;
  isFirstUserMessage: boolean;
  isLatestAgentMessage: boolean;
};

export const RuntimeTerragonMessage = memo(function RuntimeTerragonMessage({
  message,
  messageIndex,
  isLatestMessage,
  isFirstUserMessage,
  isLatestAgentMessage,
}: RuntimeTerragonMessageProps) {
  const ctx = useTerragonMessageRender();
  const rowIsAgentWorking =
    ctx.isAgentWorking && isLatestMessage && message.role === "agent";
  const renderableParts = getRenderableParts(message);
  const shouldSplitLiveTail = rowIsAgentWorking && renderableParts.length > 1;
  const staticParts = useStablePrefix(
    renderableParts,
    shouldSplitLiveTail ? renderableParts.length - 1 : 0,
  );
  const livePart = shouldSplitLiveTail
    ? renderableParts[renderableParts.length - 1]
    : null;

  if (message.role === "system") {
    return (
      <TerragonSystemMessage
        message={message}
        messageIndex={messageIndex}
        isLatestMessage={isLatestMessage}
      />
    );
  }

  return (
    <div
      className="flex flex-col gap-1 group [scroll-margin-top:6rem] [content-visibility:auto] [contain-intrinsic-size:auto_160px]"
      data-message-index={messageIndex}
      data-message-id={message.id}
      data-message-source-ids={
        message.role === "agent"
          ? message.sourceMessageIds?.join(" ")
          : undefined
      }
      data-message-role={message.role}
    >
      <div
        style={{ overflowAnchor: "none" }}
        className={cn(
          "w-full break-words",
          message.role === "user"
            ? "ml-auto w-fit max-w-[90%] sm:max-w-[85%] animate-in fade-in slide-in-from-bottom-2 rounded-[calc(var(--radius)+0.15rem)] bg-card text-card-foreground px-4 py-3 shadow-[var(--shadow-warm-lift)] md:px-5"
            : "mr-auto",
        )}
      >
        <div className="flex flex-col gap-3 text-sm leading-relaxed">
          <div className="flex flex-col gap-3">
            {shouldSplitLiveTail ? (
              <>
                <RuntimeMessageParts
                  parts={staticParts}
                  partIndexOffset={0}
                  isLatestMessage={isLatestMessage}
                  rowIsAgentWorking={rowIsAgentWorking}
                  ctx={ctx}
                />
                {livePart ? (
                  <RuntimeMessagePart
                    part={livePart}
                    partIndex={renderableParts.length - 1}
                    isLatestMessage={isLatestMessage}
                    rowIsAgentWorking={rowIsAgentWorking}
                    ctx={ctx}
                  />
                ) : null}
              </>
            ) : (
              <RuntimeMessageParts
                parts={renderableParts}
                partIndexOffset={0}
                isLatestMessage={isLatestMessage}
                rowIsAgentWorking={rowIsAgentWorking}
                ctx={ctx}
              />
            )}
            {message.role === "agent" && message.meta ? (
              <AgentMetaFooter meta={message.meta} />
            ) : null}
          </div>
        </div>
      </div>
      <MessageToolbar
        message={message}
        messageIndex={messageIndex}
        taskId={ctx.messagePartProps.toolProps.threadId}
        isFirstUserMessage={isFirstUserMessage}
        isLatestAgentMessage={isLatestAgentMessage}
        isAgentWorking={ctx.isAgentWorking}
        redoDialogData={isFirstUserMessage ? ctx.redoDialogData : undefined}
        forkDialogData={isLatestAgentMessage ? ctx.forkDialogData : undefined}
      />
    </div>
  );
});

type RuntimeMessagePartsProps = {
  parts: UIPart[];
  partIndexOffset: number;
  isLatestMessage: boolean;
  rowIsAgentWorking: boolean;
  ctx: TerragonMessageRenderContext;
};

const RuntimeMessageParts = memo(function RuntimeMessageParts({
  parts,
  partIndexOffset,
  isLatestMessage,
  rowIsAgentWorking,
  ctx,
}: RuntimeMessagePartsProps) {
  return (
    <>
      {parts.map((part, index) => (
        <RuntimeMessagePart
          key={partIndexOffset + index}
          part={part}
          partIndex={partIndexOffset + index}
          isLatestMessage={isLatestMessage}
          rowIsAgentWorking={rowIsAgentWorking}
          ctx={ctx}
        />
      ))}
    </>
  );
});

type RuntimeMessagePartProps = {
  part: UIPart;
  partIndex: number;
  isLatestMessage: boolean;
  rowIsAgentWorking: boolean;
  ctx: TerragonMessageRenderContext;
};

const RuntimeMessagePart = memo(function RuntimeMessagePart({
  part,
  partIndex,
  isLatestMessage,
  rowIsAgentWorking,
  ctx,
}: RuntimeMessagePartProps) {
  return (
    <MessagePart
      part={part}
      isLatest={isLatestMessage}
      isAgentWorking={rowIsAgentWorking}
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
  );
});

function getRenderableParts(message: UIMessage): UIPart[] {
  switch (message.role) {
    case "agent":
    case "user":
      return message.parts;
    case "system":
      return [];
  }
}
