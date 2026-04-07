"use client";

import { useState } from "react";
import {
  ThreadInfoFull,
  UIGitDiffPart,
  UISystemMessage,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { cn } from "@/lib/utils";
import { GitDiffPart } from "./git-diff-part";

export function SystemMessage({
  message,
  thread,
  latestGitDiffTimestamp,
  artifactDescriptors,
  onOpenArtifact,
}: {
  message: UISystemMessage;
  thread: ThreadInfoFull | null;
  latestGitDiffTimestamp: string | null;
  artifactDescriptors: ArtifactDescriptor[];
  onOpenArtifact: (artifactId: string) => void;
}) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const getLabel = () => {
    switch (message.message_type) {
      case "retry-git-commit-and-push":
        return "Git commit and push failed. Retrying...";
      case "generic-retry":
        return "Retrying...";
      case "invalid-token-retry":
        return "Authentication token might have expired. Retrying...";
      case "clear-context":
        return "Conversation context cleared.";
      case "compact-result":
        return "Conversation context compacted.";
      case "cancel-schedule":
        return "Scheduled task cancelled.";
      case "fix-github-checks":
        return "Fixing GitHub Checks...";
      case "sdlc-error-retry":
        return "An error occurred. Automatically retrying...";
      case "follow-up-retry-failed":
        return "Follow-up processing failed.";
      case "stop":
      case "git-diff":
        return "";
      default:
        const _exhaustiveCheck: never = message;
        return _exhaustiveCheck;
    }
  };

  const getDotClassName = () => {
    switch (message.message_type) {
      case "retry-git-commit-and-push":
      case "fix-github-checks":
      case "generic-retry":
      case "invalid-token-retry":
        return "bg-red-500";
      case "clear-context":
      case "compact-result":
        return "bg-green-500";
      case "cancel-schedule":
        return "bg-muted-foreground";
      case "sdlc-error-retry":
        return "bg-red-500";
      case "follow-up-retry-failed":
        return "bg-red-500";
      case "stop":
      case "git-diff":
        return "";
      default:
        const _exhaustiveCheck: never = message;
        return _exhaustiveCheck;
    }
  };

  const showMoreButton = message.parts.length > 0;

  if (message.message_type === "stop") {
    return <div className="p-2">Execution interrupted by user.</div>;
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
          onOpenArtifact={onOpenArtifact}
        />
      </div>
    );
  }
  return (
    <div className="py-2 px-4 rounded-xl mr-auto w-fit flex flex-col gap-2">
      <div className="flex flex-col gap-2">
        <div
          className="grid grid-cols-[auto_1fr] gap-3 text-muted-foreground/60 transition-colors hover:text-muted-foreground cursor-pointer group/system"
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          <span className="h-5 flex items-center">
            <span
              className={cn(
                "shrink-0 size-1.5 rounded-full inline-block",
                getDotClassName(),
              )}
              aria-hidden="true"
            />
          </span>
          <span className="text-[13px] font-sans tracking-[0.14px]">
            <span>{getLabel()}</span>
            {showMoreButton && (
              <>
                &nbsp;
                <span className="inline-block opacity-60 group-hover/system:opacity-100 transition-opacity select-none">
                  ({isCollapsed ? "Show more" : "Show less"})
                </span>
              </>
            )}
          </span>
        </div>
        {!isCollapsed && showMoreButton && (
          <div className="max-h-[200px] overflow-auto border border-border/30 rounded-xl p-3 bg-white/50 shadow-inset-edge">
            <pre className="whitespace-pre-wrap text-[11px] font-mono leading-relaxed text-muted-foreground/80">
              {message.parts.map((part, partIndex) => {
                return part.text;
              })}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
