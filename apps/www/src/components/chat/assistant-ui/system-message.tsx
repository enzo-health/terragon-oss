"use client";

import type { ThreadInfoFull, UISystemMessage } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { SystemMessage } from "../chat-message-system";

/**
 * Renders a lifecycle system message (git-diff, stop, etc.) in the transcript.
 * The caller (`TranscriptView`) routes only `UISystemMessage` entries here and
 * supplies the artifact/repo affordances the underlying `SystemMessage` needs.
 */
export function TerragonSystemMessage({
  message,
  messageIndex,
  thread,
  latestGitDiffTimestamp,
  artifactDescriptors,
  onOpenArtifact,
  onOpenRepoFile,
}: {
  message: UISystemMessage;
  messageIndex: number;
  thread: ThreadInfoFull | null;
  latestGitDiffTimestamp: string | null;
  artifactDescriptors: ArtifactDescriptor[];
  onOpenArtifact: (artifactId: string) => void;
  onOpenRepoFile?: (href: string) => void;
}) {
  return (
    <div
      className="flex flex-col gap-1 [scroll-margin-top:6rem]"
      data-message-index={messageIndex}
    >
      <SystemMessage
        message={message}
        thread={thread}
        latestGitDiffTimestamp={latestGitDiffTimestamp}
        artifactDescriptors={artifactDescriptors}
        onOpenArtifact={onOpenArtifact}
        onOpenRepoFile={onOpenRepoFile}
      />
    </div>
  );
}
