"use client";

import { useTerragonThread } from "./thread-context";
import { ChatMessage } from "../chat-message";
import type { UIMessage } from "@terragon/shared";

/**
 * Renders a system message (git-diff, stop, etc.) within the assistant-ui thread.
 */
export function TerragonSystemMessage({
  message,
  messageIndex,
}: {
  message: UIMessage;
  messageIndex: number;
}) {
  const ctx = useTerragonThread();

  return (
    <div
      className="flex flex-col gap-1 [scroll-margin-top:6rem]"
      data-message-index={messageIndex}
    >
      <ChatMessage
        message={message}
        isLatestMessage={messageIndex === ctx.messages.length - 1}
        isAgentWorking={false}
        thread={ctx.thread}
        latestGitDiffTimestamp={ctx.latestGitDiffTimestamp}
        artifactDescriptors={ctx.artifactDescriptors}
        onOpenArtifact={ctx.onOpenArtifact}
        planOccurrences={ctx.planOccurrences}
      />
    </div>
  );
}
