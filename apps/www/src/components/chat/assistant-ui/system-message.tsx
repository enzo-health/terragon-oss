"use client";

import { memo } from "react";
import { useTerragonThread } from "./thread-context";
import { ChatMessage } from "../chat-message";
import type { UIMessage } from "@terragon/shared";

/**
 * Renders a system message (git-diff, stop, etc.) within the assistant-ui thread.
 *
 * `isLatestMessage` is passed by the parent `TerragonThread.messages.map()`
 * loop so this component doesn't re-read `ctx.messages` on every token
 * delta.
 */
export const TerragonSystemMessage = memo(function TerragonSystemMessage({
  message,
  messageIndex,
  isLatestMessage,
}: {
  message: UIMessage;
  messageIndex: number;
  isLatestMessage: boolean;
}) {
  const ctx = useTerragonThread();

  return (
    <div
      className="flex flex-col gap-1 [scroll-margin-top:6rem]"
      data-message-index={messageIndex}
    >
      <ChatMessage
        message={message}
        isLatestMessage={isLatestMessage}
        isAgentWorking={false}
        thread={ctx.thread}
        latestGitDiffTimestamp={ctx.latestGitDiffTimestamp}
        artifactDescriptors={ctx.artifactDescriptors}
        onOpenArtifact={ctx.onOpenArtifact}
        planOccurrences={ctx.planOccurrences}
      />
    </div>
  );
});
