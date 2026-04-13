"use client";

import { useTerragonThread } from "./thread-context";
import { ChatMessage } from "../chat-message";
import { MessageToolbar } from "../chat-message-toolbar";
import type { UIMessage } from "@terragon/shared";

/**
 * Renders a user message within the assistant-ui thread.
 * Receives the original UIMessage and index directly via props.
 */
export function TerragonUserMessage({
  message,
  messageIndex,
}: {
  message: UIMessage;
  messageIndex: number;
}) {
  const ctx = useTerragonThread();
  const isFirstUserMessage = messageIndex === 0 && message.role === "user";

  return (
    <div
      className="flex flex-col gap-1 group [scroll-margin-top:6rem]"
      data-message-index={messageIndex}
    >
      <ChatMessage
        message={message}
        isLatestMessage={messageIndex === ctx.messages.length - 1}
        isAgentWorking={false}
        messagePartProps={{
          githubRepoFullName: ctx.githubRepoFullName,
          branchName: ctx.branchName,
          baseBranchName: ctx.baseBranchName,
          hasCheckpoint: ctx.hasCheckpoint,
          toolProps: ctx.toolProps,
        }}
        artifactDescriptors={ctx.artifactDescriptors}
        onOpenArtifact={ctx.onOpenArtifact}
        planOccurrences={ctx.planOccurrences}
      />
      <MessageToolbar
        message={message}
        messageIndex={messageIndex}
        isFirstUserMessage={isFirstUserMessage}
        isLatestAgentMessage={false}
        isAgentWorking={ctx.isAgentWorking}
        redoDialogData={isFirstUserMessage ? ctx.redoDialogData : undefined}
      />
    </div>
  );
}
