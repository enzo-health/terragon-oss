"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRouter } from "next/navigation";
import type { DBUserMessage } from "@terragon/shared";
import { GenericPromptBox } from "../promptbox/generic-promptbox";
import { redoThread } from "@/server-actions/redo-thread";
import { RepoBranchSelector } from "../repo-branch-selector";
import {
  PromptBoxToolBelt,
  usePromptBoxToolBeltOptions,
} from "../promptbox/prompt-box-tool-belt";
import { useServerActionMutation } from "@/queries/server-action-helpers";

export function RedoTaskDialog({
  threadId,
  repoFullName,
  repoBaseBranchName,
  disableGitCheckpointing,
  skipSetup,
  permissionMode,
  initialUserMessage,
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadId: string;
  repoFullName: string;
  repoBaseBranchName: string;
  disableGitCheckpointing: boolean;
  skipSetup: boolean;
  permissionMode: "allowAll" | "plan";
  initialUserMessage: DBUserMessage;
}) {
  const router = useRouter();
  const [selectedRepoFullName, setSelectedRepoFullName] =
    useState<string>(repoFullName);
  const [branchName, setBranchName] = useState<string>(repoBaseBranchName);
  const {
    createNewBranch,
    setCreateNewBranch,
    disableGitCheckpointing: disableGitCheckpointingValue,
    skipSetup: skipSetupValue,
    setDisableGitCheckpointing: setDisableGitCheckpointingValue,
    setSkipSetup: setSkipSetupValue,
    skipArchiving,
    setSkipArchiving,
  } = usePromptBoxToolBeltOptions({
    branchName,
    shouldUseCookieValues: false,
    initialDisableGitCheckpointing: disableGitCheckpointing,
    initialSkipSetup: skipSetup,
    initialCreateNewBranch: true,
  });

  const redoThreadMutation = useServerActionMutation({
    mutationFn: async ({ userMessage }: { userMessage: DBUserMessage }) => {
      return await redoThread({
        threadId,
        userMessage,
        repoFullName: selectedRepoFullName,
        branchName,
        disableGitCheckpointing: disableGitCheckpointingValue,
        skipArchiving,
        skipSetup: skipSetupValue,
      });
    },
    onSuccess: () => {
      onOpenChange(false);
      router.push("/dashboard");
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] flex flex-col">
        <DialogHeader>
          <DialogTitle>Try this task again!</DialogTitle>
          <DialogDescription>
            Edit your initial message below. A new task will be created with
            your updated message.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 flex-1 overflow-y-auto min-h-0">
          <GenericPromptBox
            className="min-h-[200px] max-h-[80dvh]"
            placeholder="Edit your initial message..."
            message={{
              ...initialUserMessage,
              permissionMode,
            }}
            repoFullName={selectedRepoFullName}
            branchName={branchName}
            onSubmit={redoThreadMutation.mutateAsync}
            hideSubmitButton={false}
            autoFocus={true}
            forcedAgent={null}
            forcedAgentVersion={null}
          />
          <div className="flex items-center justify-between">
            <RepoBranchSelector
              selectedRepoFullName={selectedRepoFullName}
              selectedBranch={branchName}
              onChange={(repoFullName, branchName) => {
                if (repoFullName) {
                  setSelectedRepoFullName(repoFullName);
                }
                if (branchName) {
                  setBranchName(branchName);
                }
              }}
            />
            <PromptBoxToolBelt
              showSkipArchive={true}
              skipArchiveValue={skipArchiving}
              onSkipArchiveChange={setSkipArchiving}
              showSkipSetup={true}
              skipSetupValue={skipSetupValue}
              onSkipSetupChange={setSkipSetupValue}
              skipSetupDisabled={!selectedRepoFullName}
              showCheckpoint={true}
              checkpointValue={disableGitCheckpointingValue}
              onCheckpointChange={setDisableGitCheckpointingValue}
              checkpointDisabled={!selectedRepoFullName}
              showCreateNewBranchOption={true}
              createNewBranchValue={createNewBranch}
              onCreateNewBranchChange={setCreateNewBranch}
              createNewBranchDisabled={!selectedRepoFullName}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
