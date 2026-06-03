"use client";

import { useTerragonThread } from "./thread-context";
import { SystemMessage } from "../chat-message-system";
import type { UISystemMessage } from "@terragon/shared";

/**
 * Renders a system message (git-diff, stop, etc.) within the assistant-ui
 * thread. The caller (`TerragonTranscriptSurface`) only routes
 * `UISystemMessage` lifecycle entries here.
 */
export function TerragonSystemMessage({
  message,
  messageIndex,
}: {
  message: UISystemMessage;
  messageIndex: number;
}) {
  const ctx = useTerragonThread();

  return (
    <div
      className="flex flex-col gap-1 [scroll-margin-top:6rem]"
      data-message-index={messageIndex}
    >
      <SystemMessage
        message={message}
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
