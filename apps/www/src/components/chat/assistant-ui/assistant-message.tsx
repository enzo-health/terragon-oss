"use client";

import { useTerragonThread } from "./thread-context";
import { ChatMessage } from "../chat-message";
import { MessageToolbar } from "../chat-message-toolbar";
import type { UIMessage } from "@terragon/shared";

/**
 * Renders an assistant/agent message within the assistant-ui thread.
 */
export function TerragonAssistantMessage({
  message,
  messageIndex,
}: {
  message: UIMessage;
  messageIndex: number;
}) {
  const ctx = useTerragonThread();
  const isLatestMessage = messageIndex === ctx.messages.length - 1;
  const isLatestAgentMessage =
    message.role === "agent" && messageIndex === ctx.latestAgentMessageIndex;
  const rowIsAgentWorking =
    ctx.isAgentWorking && isLatestMessage && message.role === "agent";

  return (
    <div
      className="flex flex-col gap-1 group [scroll-margin-top:6rem]"
      data-message-index={messageIndex}
    >
      <ChatMessage
        message={message}
        isLatestMessage={isLatestMessage}
        isAgentWorking={rowIsAgentWorking}
        messagePartProps={{
          githubRepoFullName: ctx.githubRepoFullName,
          branchName: ctx.branchName,
          baseBranchName: ctx.baseBranchName,
          hasCheckpoint: ctx.hasCheckpoint,
          toolProps: ctx.toolProps,
        }}
        thread={message.role === "system" ? ctx.thread : null}
        latestGitDiffTimestamp={
          message.role === "system" ? ctx.latestGitDiffTimestamp : null
        }
        artifactDescriptors={ctx.artifactDescriptors}
        onOpenArtifact={ctx.onOpenArtifact}
        planOccurrences={ctx.planOccurrences}
      />
      <MessageToolbar
        message={message}
        messageIndex={messageIndex}
        isFirstUserMessage={false}
        isLatestAgentMessage={isLatestAgentMessage}
        isAgentWorking={ctx.isAgentWorking}
        forkDialogData={isLatestAgentMessage ? ctx.forkDialogData : undefined}
      />
    </div>
  );
}
