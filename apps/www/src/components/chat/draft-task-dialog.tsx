"use client";

import isEqual from "fast-deep-equal";
import { useDebouncedCallback } from "use-debounce";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DBUserMessage, ThreadInfo } from "@leo/shared";
import { GenericPromptBox } from "../promptbox/generic-promptbox";
import { RepoBranchSelector } from "../repo-branch-selector";
import { HandleSubmit, HandleUpdate } from "../promptbox/use-promptbox";
import {
  useSubmitDraftThreadMutation,
  useUpdateDraftThreadMutation,
} from "@/queries/thread-mutations";
import {
  PromptBoxToolBelt,
  usePromptBoxToolBeltOptions,
} from "../promptbox/prompt-box-tool-belt";

interface DraftTaskModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thread: ThreadInfo;
}

const emptyMessage: DBUserMessage = {
  type: "user",
  model: "sonnet",
  parts: [{ type: "text", text: "" }],
};

export function DraftTaskDialog({
  thread,
  open,
  onOpenChange,
}: DraftTaskModalProps) {
  // draftMessage should never be null, for draft threads but make sure we
  // handle it gracefully anyway.
  const [draftMessage, setDraftMessage] = useState(
    thread.draftMessage ?? emptyMessage,
  );
  const [selectedRepoFullName, setSelectedRepoFullName] = useState(
    thread.githubRepoFullName,
  );
  const [selectedBranch, setSelectedBranch] = useState(
    thread.repoBaseBranchName,
  );
  const updateDraftThreadMutation = useUpdateDraftThreadMutation();
  const submitDraftThreadMutation = useSubmitDraftThreadMutation();

  const {
    disableGitCheckpointing,
    skipSetup,
    setDisableGitCheckpointing,
    setSkipSetup,
  } = usePromptBoxToolBeltOptions({
    branchName: selectedBranch,
    shouldUseCookieValues: false,
    initialDisableGitCheckpointing: !!thread.disableGitCheckpointing,
    initialSkipSetup: !!thread.skipSetup,
  });

  // Use a ref to store the debounced callback so handleSubmit can cancel it
  const handleUpdateRef = useRef<ReturnType<typeof useDebouncedCallback>>(null);

  const handleUpdate = useDebouncedCallback(
    useCallback<HandleUpdate>(
      async ({ userMessage }) => {
        setDraftMessage(userMessage);
        if (
          userMessage.model !== draftMessage.model ||
          userMessage.permissionMode !== draftMessage.permissionMode ||
          !isEqual(userMessage.parts, draftMessage.parts)
        ) {
          await updateDraftThreadMutation.mutateAsync({
            threadId: thread.id,
            updates: { userMessage },
          });
        }
      },
      [thread.id, updateDraftThreadMutation, draftMessage],
    ),
    1000,
  );

  // Store the debounced callback in a ref so handleSubmit can cancel it
  handleUpdateRef.current = handleUpdate;

  const handleSubmit = useCallback<HandleSubmit>(
    async ({ userMessage, selectedModels, saveAsDraft, scheduleAt }) => {
      // Cancel any pending debounced updates to prevent race condition
      // where handleUpdate fires after submitDraftThread has cleared draftMessage
      handleUpdateRef.current?.cancel();

      if (saveAsDraft) {
        await updateDraftThreadMutation.mutateAsync({
          threadId: thread.id,
          updates: { userMessage },
        });
      } else {
        await submitDraftThreadMutation.mutateAsync({
          threadId: thread.id,
          userMessage,
          selectedModels,
          scheduleAt,
        });
      }
      onOpenChange(false);
    },
    [
      thread.id,
      onOpenChange,
      submitDraftThreadMutation,
      updateDraftThreadMutation,
    ],
  );

  useEffect(() => {
    return () => {
      if (handleUpdate.isPending()) {
        handleUpdate.flush();
      }
    };
  }, [handleUpdate]);
  const handleRepoBranchChange = useCallback(
    async (repoFullName: string, branchName: string) => {
      await updateDraftThreadMutation.mutateAsync({
        threadId: thread.id,
        updates: { repoFullName, branchName },
      });
      setSelectedRepoFullName(repoFullName);
      setSelectedBranch(branchName);
    },
    [thread.id, updateDraftThreadMutation],
  );
  const handleToggleCheckpoint = useCallback(
    async (disabled: boolean) => {
      setDisableGitCheckpointing(disabled);
      await updateDraftThreadMutation.mutateAsync({
        threadId: thread.id,
        updates: { disableGitCheckpointing: disabled },
      });
    },
    [thread.id, updateDraftThreadMutation, setDisableGitCheckpointing],
  );
  const handleToggleSkipSetup = useCallback(
    async (disabled: boolean) => {
      setSkipSetup(disabled);
      await updateDraftThreadMutation.mutateAsync({
        threadId: thread.id,
        updates: { skipSetup: disabled },
      });
    },
    [thread.id, updateDraftThreadMutation, setSkipSetup],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] flex flex-col max-h-[95dvh]">
        <DialogHeader>
          <DialogTitle>Draft</DialogTitle>
          <DialogDescription>
            Edit and submit your draft below
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 flex-1 overflow-y-auto min-h-0">
          <GenericPromptBox
            className="min-h-[120px] max-h-[200px] sm:min-h-[200px] sm:max-h-[400px]"
            placeholder="Edit your draft..."
            message={draftMessage}
            repoFullName={thread.githubRepoFullName}
            branchName={thread.repoBaseBranchName}
            onSubmit={handleSubmit}
            onUpdate={handleUpdate}
            hideSubmitButton={false}
            autoFocus={true}
            forcedAgent={null}
            forcedAgentVersion={null}
            clearContentOnSubmit={false}
            supportSaveAsDraft={true}
            supportSchedule={true}
            supportMultiAgentPromptSubmission={true}
          />
          <div className="flex items-center justify-between">
            <RepoBranchSelector
              selectedRepoFullName={selectedRepoFullName}
              selectedBranch={selectedBranch}
              onChange={async (repoFullName, branchName) => {
                if (repoFullName && branchName) {
                  await handleRepoBranchChange(repoFullName, branchName);
                }
              }}
            />
            <PromptBoxToolBelt
              showSkipSetup={true}
              skipSetupValue={skipSetup}
              onSkipSetupChange={handleToggleSkipSetup}
              skipSetupDisabled={!selectedRepoFullName}
              showCheckpoint={true}
              checkpointValue={disableGitCheckpointing}
              onCheckpointChange={handleToggleCheckpoint}
              checkpointDisabled={!selectedRepoFullName}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
