"use client";

import { memo } from "react";
import { useTerragonThread } from "./thread-context";
import { ChatMessage } from "../chat-message";
import { MessageToolbar } from "../chat-message-toolbar";
import type { UIMessage } from "@terragon/shared";

/**
 * Renders an assistant/agent message within the assistant-ui thread.
 *
 * `isLatestMessage` / `isLatestAgentMessage` are passed by the parent
 * `TerragonThread.messages.map()` loop so this component doesn't have
 * to read the whole `messages` array from context — that would force
 * every row to re-render on every token delta.
 */
export const TerragonAssistantMessage = memo(function TerragonAssistantMessage({
  message,
  messageIndex,
  isLatestMessage,
  isLatestAgentMessage,
}: {
  message: UIMessage;
  messageIndex: number;
  isLatestMessage: boolean;
  isLatestAgentMessage: boolean;
}) {
  const ctx = useTerragonThread();
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
        messagePartProps={ctx.messagePartProps}
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
});
