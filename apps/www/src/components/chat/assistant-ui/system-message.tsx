"use client";

import { useTerragonThread } from "./thread-context";
import { SystemMessage } from "../chat-message-system";
import type { UIMessage, UISystemMessage } from "@terragon/shared";

/**
 * Renders a system message (git-diff, stop, etc.) within the assistant-ui
 * thread. `message` is narrowed to `UISystemMessage` before rendering — the
 * caller only routes system-role messages here.
 *
 * `isLatestMessage` is passed by the parent `TerragonThread.messages.map()`
 * loop so this component doesn't re-read `ctx.messages` on every token
 * delta.
 */
export function TerragonSystemMessage({
  message,
  messageIndex,
  isLatestMessage: _isLatestMessage,
}: {
  message: UIMessage;
  messageIndex: number;
  isLatestMessage: boolean;
}) {
  const ctx = useTerragonThread();
  if (message.role !== "system") return null;
  const systemMessage: UISystemMessage = message;

  return (
    <div
      className="flex flex-col gap-1 [scroll-margin-top:6rem]"
      data-message-index={messageIndex}
    >
      <SystemMessage
        message={systemMessage}
        thread={ctx.thread}
        latestGitDiffTimestamp={ctx.latestGitDiffTimestamp}
        artifactDescriptors={ctx.artifactDescriptors}
        artifactDescriptorLookup={ctx.artifactDescriptorLookup}
        onOpenArtifact={ctx.onOpenArtifact}
        onOpenRepoFile={ctx.onOpenRepoFile}
      />
    </div>
  );
}
