"use client";

import type { UIMessage } from "@terragon/shared";
import { memo } from "react";
import { cn } from "@/lib/utils";
import { AgentMetaFooter } from "../chat-message-agent-meta-footer";
import { MessageToolbar } from "../chat-message-toolbar";
import { MessagePart } from "../message-part";
import { TerragonSystemMessage } from "./system-message";
import { useTerragonThread } from "./thread-context";

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
  const ctx = useTerragonThread();
  const rowIsAgentWorking =
    ctx.isAgentWorking && isLatestMessage && message.role === "agent";

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
            {message.parts.map((part, partIndex) => (
              <MessagePart
                key={partIndex}
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
                planOccurrenceIndex={ctx.planOccurrences.get(part)}
              />
            ))}
            {message.role === "agent" && message.meta ? (
              <AgentMetaFooter meta={message.meta} />
            ) : null}
          </div>
        </div>
      </div>
      <MessageToolbar
        message={message}
        messageIndex={messageIndex}
        taskId={ctx.toolProps.threadId}
        isFirstUserMessage={isFirstUserMessage}
        isLatestAgentMessage={isLatestAgentMessage}
        isAgentWorking={ctx.isAgentWorking}
        redoDialogData={isFirstUserMessage ? ctx.redoDialogData : undefined}
        forkDialogData={isLatestAgentMessage ? ctx.forkDialogData : undefined}
      />
    </div>
  );
});
