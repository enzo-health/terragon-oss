"use client";

import React from "react";
import { toast } from "sonner";
import { ThreadInfo, ThreadInfoFull } from "@leo/shared";
import { AIAgent } from "@leo/agent/types";
import { useCallback, useState, useEffect } from "react";
import {
  Terminal,
  Copy,
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { openPullRequest } from "@/server-actions/pull-request";
import { getThreadPageDiffAction } from "@/server-actions/get-thread-page-diff";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Checkbox } from "../ui/checkbox";
import { publicDocsUrl } from "@leo/env/next-public";
import { useAtomValue } from "jotai";
import { userSettingsAtom } from "@/atoms/user";
import { useServerActionMutation } from "@/queries/server-action-helpers";

export function CodeButton({
  thread,
  agent,
}: {
  thread: ThreadInfoFull;
  agent: AIAgent;
}) {
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [openClaude, setOpenClaude] = useState(false);
  // Check if this is a claude code agent
  const isClaudeCodeAgent = agent === "claudeCode";

  // Load the preference from localStorage on mount
  useEffect(() => {
    // Don't load preference for non claude code agents
    if (isClaudeCodeAgent) {
      const stored = localStorage.getItem("terry-open-claude");
      if (stored === "true") {
        setOpenClaude(true);
      }
    }
  }, [isClaudeCodeAgent]);

  // Save the preference to localStorage when it changes
  const handleOpenClaudeChange = (checked: boolean) => {
    setOpenClaude(checked);
    localStorage.setItem("terry-open-claude", String(checked));
  };

  const copyToClipboard = async (
    text: string,
    message: string,
    commandId: string,
  ) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(message);
      setCopiedCommand(commandId);
      setTimeout(() => setCopiedCommand(null), 2000);
    } catch (err) {
      console.error("Failed to copy", err);
      toast.error("Failed to copy");
    }
  };

  const pullCommand = `terry pull${openClaude && isClaudeCodeAgent ? " -r" : ""} ${thread.id}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="default">
          <Terminal className="h-4 w-4" />
          <span className="hidden sm:inline">Code</span>
          <ChevronDown className="h-4 w-4 ml-1" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="flex flex-col">
          {/* Header - matching Share modal style */}
          <div className="p-3 border-b">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">Pull with Terry CLI</h4>
              <a
                href={`${publicDocsUrl()}/docs/integrations/cli`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground underline hover:text-foreground inline-flex items-center gap-1"
              >
                Install CLI
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>

          {/* Pull section */}
          <div className="p-3 border-b">
            <div
              className="flex items-center bg-muted rounded-md font-mono text-sm cursor-pointer hover:bg-muted/80 transition-colors"
              onClick={() => {
                copyToClipboard(pullCommand, "Copied pull command", "terry");
              }}
            >
              <div className="flex-1 overflow-x-auto p-2 [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb]:rounded-full">
                <code className="text-xs whitespace-nowrap">{pullCommand}</code>
              </div>
              <button
                className="h-7 w-7 p-0 mr-1 flex-shrink-0 flex items-center justify-center"
                aria-label="Copy command"
              >
                {copiedCommand === "terry" ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </button>
            </div>
            {isClaudeCodeAgent && (
              <div className="flex items-center space-x-2 mt-3">
                <Checkbox
                  id="open-claude"
                  checked={openClaude}
                  onCheckedChange={handleOpenClaudeChange}
                />
                <label
                  htmlFor="open-claude"
                  className="text-xs text-muted-foreground cursor-pointer select-none"
                >
                  Open Claude after pull
                </label>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="p-1">
            <ViewOrCreatePRButton
              thread={thread}
              closePopover={() => setOpen(false)}
            />
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={async () => {
                let gitDiff = thread.gitDiff;
                if (!gitDiff) {
                  const diffResult = await getThreadPageDiffAction(thread.id);
                  gitDiff = diffResult.success
                    ? (diffResult.data?.gitDiff ?? null)
                    : null;
                }
                if (!gitDiff) {
                  toast.error("No changes to copy");
                  return;
                }
                const patchCommand = `git apply - <<'PATCH'\n${gitDiff}\nPATCH`;
                copyToClipboard(patchCommand, "Copied patch command", "patch");
              }}
            >
              <Copy className="h-4 w-4 mr-2" />
              Copy Git Patch
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ViewOrCreatePRButton({
  thread,
  closePopover,
}: {
  thread: ThreadInfo;
  closePopover: () => void;
}) {
  const [isCreatingPR, setIsCreatingPR] = useState(false);
  const [isCreatingDraftPR, setIsCreatingDraftPR] = useState(false);
  const userSettings = useAtomValue(userSettingsAtom);
  const openPullRequestMutation = useServerActionMutation({
    mutationFn: openPullRequest,
  });

  // Use user's preference for PR type, default to draft if not set
  const preferredPrType = userSettings?.prType || "draft";

  const createPR = useCallback(
    async ({ draftPR }: { draftPR: boolean }) => {
      try {
        if (draftPR) {
          setIsCreatingDraftPR(true);
        } else {
          setIsCreatingPR(true);
        }
        await openPullRequestMutation.mutateAsync({
          threadId: thread.id,
          prType: draftPR ? "draft" : "ready",
        });
        closePopover();
      } catch (err) {
        console.error("Failed to create pull request", err);
      } finally {
        if (draftPR) {
          setIsCreatingDraftPR(false);
        } else {
          setIsCreatingPR(false);
        }
      }
    },
    [thread, closePopover, openPullRequestMutation],
  );

  if (thread.githubPRNumber) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start"
        onClick={() => {
          const prUrl = `https://github.com/${thread.githubRepoFullName}/pull/${thread.githubPRNumber}`;
          window.open(prUrl, "_blank");
        }}
      >
        <ExternalLink className="h-4 w-4 mr-2" />
        View Pull Request
      </Button>
    );
  } else {
    // Show only one button based on user's preference
    const isDraft = preferredPrType === "draft";
    const isCreating = isDraft ? isCreatingDraftPR : isCreatingPR;

    return (
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start"
        onClick={() => createPR({ draftPR: isDraft })}
        disabled={isCreating}
      >
        <ExternalLink className="h-4 w-4 mr-2" />
        {isDraft ? "Create Draft PR" : "Create Pull Request"}
        {isCreating && <Loader2 className="h-3 w-3 ml-auto animate-spin" />}
      </Button>
    );
  }
}
