"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DBUserMessage, GitDiffStats } from "@leo/shared";
import { GenericPromptBox } from "../promptbox/generic-promptbox";
import { forkThread } from "@/server-actions/fork-thread";
import { RepoBranchSelector } from "../repo-branch-selector";
import { PromptBoxToolBelt } from "../promptbox/prompt-box-tool-belt";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import { toast } from "sonner";
import { getDefaultModelForAgent } from "@leo/agent/utils";
import { usePromptBoxToolBeltOptions } from "../promptbox/prompt-box-tool-belt";
import { AIAgent, AIModel } from "@leo/agent/types";

export function ForkTaskDialog({
  threadId,
  threadChatId,
  repoFullName,
  repoBaseBranchName,
  branchName: initialBranchName,
  gitDiffStats,
  disableGitCheckpointing: initialDisableGitCheckpointing,
  skipSetup: initialSkipSetup,
  agent,
  lastSelectedModel,
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadId: string;
  threadChatId: string;
  repoFullName: string;
  repoBaseBranchName: string;
  branchName: string | null;
  gitDiffStats: GitDiffStats | null;
  disableGitCheckpointing: boolean;
  skipSetup: boolean;
  agent: AIAgent;
  lastSelectedModel: AIModel | null;
}) {
  const [branchName, setBranchName] = useState<string>(
    // Only use the thread branch name if it exists and has git diff stats, which
    // means the branch has changes and we've pushed it to GitHub.
    gitDiffStats && initialBranchName ? initialBranchName : repoBaseBranchName,
  );
  const {
    skipSetup,
    disableGitCheckpointing,
    createNewBranch,
    setSkipSetup,
    setDisableGitCheckpointing,
    setCreateNewBranch,
  } = usePromptBoxToolBeltOptions({
    branchName,
    shouldUseCookieValues: false,
    initialSkipSetup,
    initialDisableGitCheckpointing,
    initialCreateNewBranch: true,
  });
  const defaultModel =
    lastSelectedModel ??
    getDefaultModelForAgent({
      agent,
      agentVersion: "latest",
    });

  const forkThreadMutation = useServerActionMutation({
    mutationFn: async ({ userMessage }: { userMessage: DBUserMessage }) => {
      return await forkThread({
        threadId,
        threadChatId,
        userMessage,
        repoFullName,
        branchName,
        disableGitCheckpointing,
        skipSetup,
        createNewBranch,
      });
    },
    onSuccess: () => {
      onOpenChange(false);
      toast.success("Task created");
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] flex flex-col">
        <DialogHeader>
          <DialogTitle>Fork this task</DialogTitle>
          <DialogDescription>
            Create a new task based on this one. The task context will be
            compacted and included with your new message.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 flex-1 overflow-y-auto min-h-0">
          <GenericPromptBox
            className="min-h-[200px] max-h-[80dvh]"
            placeholder="Describe what you want to do with this task..."
            message={{
              type: "user",
              model: defaultModel,
              parts: [],
            }}
            repoFullName={repoFullName}
            branchName={branchName}
            onSubmit={forkThreadMutation.mutateAsync}
            hideSubmitButton={false}
            autoFocus={true}
            forcedAgent={null}
            forcedAgentVersion={null}
          />
          <div className="flex items-center justify-between">
            <RepoBranchSelector
              hideRepoSelector
              selectedRepoFullName={repoFullName}
              selectedBranch={branchName}
              onChange={(_, branchName) => {
                if (branchName) {
                  setBranchName(branchName);
                }
              }}
            />
            <PromptBoxToolBelt
              showSkipArchive={false}
              skipArchiveValue={false}
              onSkipArchiveChange={() => {}}
              showSkipSetup={true}
              skipSetupValue={skipSetup}
              onSkipSetupChange={setSkipSetup}
              skipSetupDisabled={!repoFullName}
              showCreateNewBranchOption={true}
              createNewBranchValue={createNewBranch}
              onCreateNewBranchChange={setCreateNewBranch}
              createNewBranchDisabled={!repoFullName}
              showCheckpoint={true}
              checkpointValue={disableGitCheckpointing}
              onCheckpointChange={setDisableGitCheckpointing}
              checkpointDisabled={!repoFullName}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
