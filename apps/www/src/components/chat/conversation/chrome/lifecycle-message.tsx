"use client";

import {
  ThreadInfoFull,
  UIGitDiffPart,
  UISystemMessage,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import React, { useState } from "react";
import { CodeBlock, CodeBlockContent } from "@/components/ai/code-block";
import { Status } from "@/components/ai/status";
import { GitDiffPart } from "../../git-diff-part";
import type { ArtifactDescriptorLookup } from "../../secondary-panel-helpers";

export function SystemMessage({
  message,
  thread,
  latestGitDiffTimestamp,
  artifactDescriptors,
  artifactDescriptorLookup,
  onOpenArtifact,
  onOpenRepoFile,
}: {
  message: UISystemMessage;
  thread: ThreadInfoFull | null;
  latestGitDiffTimestamp: string | null;
  artifactDescriptors: ArtifactDescriptor[];
  artifactDescriptorLookup?: ArtifactDescriptorLookup;
  onOpenArtifact: (artifactId: string) => void;
  onOpenRepoFile?: (filePath: string) => void;
}) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const getLabel = () => {
    switch (message.message_type) {
      case "retry-git-commit-and-push":
        return "Retrying push after git failure";
      case "generic-retry":
        return "Retrying";
      case "invalid-token-retry":
        return "Auth token expired, retrying";
      case "clear-context":
        return "Context cleared";
      case "compact-result":
        return "Context compacted";
      case "cancel-schedule":
        return "Schedule cancelled";
      case "fix-github-checks":
        return "Fixing GitHub checks";
      case "agent-error-retry":
        return "Retrying after error";
      case "follow-up-retry-failed":
        return "Follow-up failed";
      case "auto-fix-ci-failure":
        return "Auto-fixing CI failures";
      case "auto-respond-changes-requested":
        return "Addressing requested review changes";
      case "stop":
      case "git-diff":
        return "";
      default:
        const _exhaustiveCheck: never = message;
        return _exhaustiveCheck;
    }
  };

  const getStatusState = () => {
    switch (message.message_type) {
      case "retry-git-commit-and-push":
      case "fix-github-checks":
      case "generic-retry":
      case "invalid-token-retry":
      case "agent-error-retry":
      case "follow-up-retry-failed":
      case "auto-fix-ci-failure":
      case "auto-respond-changes-requested":
        return "error" as const;
      case "clear-context":
      case "compact-result":
        return "active" as const;
      case "cancel-schedule":
        return "pending" as const;
      case "stop":
      case "git-diff":
        return "neutral" as const;
      default:
        const _exhaustiveCheck: never = message;
        return _exhaustiveCheck;
    }
  };

  const showMoreButton = message.parts.length > 0;

  if (message.message_type === "stop") {
    return (
      <div className="p-2 text-sm text-muted-foreground">
        Execution interrupted by user.
      </div>
    );
  }
  if (message.message_type === "git-diff") {
    if (!thread) {
      return null;
    }
    const gitDiffPart = message.parts[0] as UIGitDiffPart;
    return (
      <div className="p-2">
        <GitDiffPart
          gitDiffPart={gitDiffPart}
          thread={thread}
          isLatest={latestGitDiffTimestamp === gitDiffPart.timestamp}
          artifactDescriptors={artifactDescriptors}
          artifactDescriptorLookup={artifactDescriptorLookup}
          onOpenArtifact={onOpenArtifact}
          onOpenRepoFile={onOpenRepoFile}
        />
      </div>
    );
  }
  return (
    <div className="py-2 px-4 mr-auto w-fit flex flex-col gap-2">
      <Status
        state={getStatusState()}
        size="sm"
        render={
          showMoreButton ? (
            <button
              type="button"
              onClick={() => setIsCollapsed(!isCollapsed)}
            />
          ) : undefined
        }
      >
        <span className="tracking-[0.14px]">{getLabel()}</span>
        {showMoreButton && (
          <span className="opacity-60 select-none">
            ({isCollapsed ? "Show more" : "Show less"})
          </span>
        )}
      </Status>
      {!isCollapsed && showMoreButton && (
        <CodeBlock>
          <CodeBlockContent className="max-h-[200px] overflow-auto">
            <pre className="whitespace-pre-wrap text-[11px] font-mono leading-relaxed text-muted-foreground/80">
              {message.parts.map((part) => {
                return part.text;
              })}
            </pre>
          </CodeBlockContent>
        </CodeBlock>
      )}
    </div>
  );
}

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
