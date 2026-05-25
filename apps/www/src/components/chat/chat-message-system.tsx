"use client";

import {
  ThreadInfoFull,
  UIGitDiffPart,
  UISystemMessage,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { GitDiffPart } from "./git-diff-part";
import type { ArtifactDescriptorLookup } from "./secondary-panel-helpers";

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
  onOpenRepoFile?: (path: string, preferArtifactId?: string) => void;
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

  const getDotClassName = () => {
    switch (message.message_type) {
      case "retry-git-commit-and-push":
      case "fix-github-checks":
      case "generic-retry":
      case "invalid-token-retry":
      case "agent-error-retry":
      case "follow-up-retry-failed":
      case "auto-fix-ci-failure":
      case "auto-respond-changes-requested":
        // Semantic destructive — uses theme token, dark-mode safe
        return "bg-error";
      case "clear-context":
      case "compact-result":
        return "bg-emerald-500 dark:bg-emerald-400";
      case "cancel-schedule":
        return "bg-muted-foreground";
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
          artifactDescriptorLookup={artifactDescriptorLookup}
          onOpenArtifact={onOpenArtifact}
          onOpenRepoFile={onOpenRepoFile}
        />
      </div>
    );
  }
  return (
    <div className="py-2 px-4 rounded-xl mr-auto w-fit flex flex-col gap-2">
      <div className="flex flex-col gap-2">
        <div
          className="grid grid-cols-[auto_1fr] gap-3 text-muted-foreground/70 transition-colors hover:text-muted-foreground cursor-pointer group/system"
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
          <div className="max-h-[200px] overflow-auto rounded-xl p-3 bg-muted/40 dark:bg-muted/30 shadow-inset-edge">
            <pre className="whitespace-pre-wrap text-[11px] font-mono leading-relaxed text-muted-foreground/80">
              {message.parts.map((part) => {
                return part.text;
              })}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
