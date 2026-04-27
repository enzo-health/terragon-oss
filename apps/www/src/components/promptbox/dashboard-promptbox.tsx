"use client";

import { modelToAgent } from "@terragon/agent/utils";
import { ThreadStatus } from "@terragon/shared";
import React, { useCallback, useMemo, useState } from "react";
import { useCredentialInfoForAgent } from "@/atoms/user-credentials";
import { useSelectedRepoAndBranch } from "@/hooks/useSelectedRepoAndBranch";
import { RepoBranchSelector } from "../repo-branch-selector";
import { CredentialsWarning } from "./credentials-warning";
import {
  PromptBoxToolBelt,
  usePromptBoxToolBeltOptions,
} from "./prompt-box-tool-belt";
import { SimplePromptBox } from "./simple-promptbox";
import { useRepositoryCache } from "./typeahead/repository-cache";
import {
  HandleStop,
  HandleUpdate,
  HandleSubmit as UsePromptBoxHandleSubmit,
  HandleSubmitArgs as UsePromptBoxHandleSubmitArgs,
  usePromptBox,
} from "./use-promptbox";

export type DashboardPromptBoxHandleSubmit = (
  args: UsePromptBoxHandleSubmitArgs & {
    disableGitCheckpointing: boolean;
    skipSetup: boolean;
    createNewBranch: boolean;
  },
) => Promise<void>;

interface DashboardPromptBoxProps {
  placeholder?: string;
  threadId: string | null;
  status: ThreadStatus | null;
  promptText?: string;
  handleStop: HandleStop;
  onUpdate: HandleUpdate;
  handleSubmit: DashboardPromptBoxHandleSubmit;
}

export function DashboardPromptBox(props: DashboardPromptBoxProps) {
  const { selectedRepo, selectedBranch, setSelectedRepoAndBranch } =
    useSelectedRepoAndBranch();
  const repoFullName = selectedRepo;
  const branchName = selectedBranch;
  const [isRecording, setIsRecording] = useState(false);
  const onRepoBranchChange = useCallback(
    (repo: string | null, branch: string | null) => {
      void setSelectedRepoAndBranch(repo, branch);
    },
    [setSelectedRepoAndBranch],
  );

  const repositoryCache = useRepositoryCache({
    repoFullName: repoFullName ?? "",
    branchName: branchName ?? "",
  });

  const {
    skipSetup,
    disableGitCheckpointing,
    createNewBranch,
    setSkipSetup,
    setDisableGitCheckpointing,
    setCreateNewBranch,
  } = usePromptBoxToolBeltOptions({
    branchName,
    shouldUseCookieValues: true,
  });
  const placeholderText = useMemo(() => {
    if (props.placeholder != null) return props.placeholder;
    if (!repoFullName || !branchName) {
      return "Select a repository and branch to start...";
    }
    return "Type your message here... Use @ to mention files (Enter to send)";
  }, [props.placeholder, repoFullName, branchName]);

  const wrappedHandleSubmit: UsePromptBoxHandleSubmit = useCallback(
    async ({
      userMessage,
      selectedModels,
      repoFullName,
      branchName,
      saveAsDraft,
      scheduleAt,
    }) => {
      return props.handleSubmit({
        userMessage,
        selectedModels,
        repoFullName,
        branchName,
        saveAsDraft,
        scheduleAt,
        disableGitCheckpointing,
        skipSetup,
        createNewBranch,
      });
    },
    [props, disableGitCheckpointing, skipSetup, createNewBranch],
  );

  const {
    editor,
    attachedFiles,
    isSubmitting,
    isSubmitDisabled: baseIsSubmitDisabled,
    handleFilesAttached,
    removeFile,
    submitForm,
    permissionMode,
    setPermissionMode,
    selectedModel,
    selectedModels,
    setSelectedModel,
    isMultiAgentMode,
    setIsMultiAgentMode,
  } = usePromptBox({
    ...props,
    placeholderText,
    repoFullName,
    branchName,
    forcedAgent: null,
    forcedAgentVersion: null,
    initialSelectedModel: null,
    persistSelectedModelToUserFlags: true,
    typeahead: repositoryCache,
    clearContentBeforeSubmit: false,
    requireRepoAndBranch: true,
    storageKeyPrefix: "prompt-box-input-dashboard",
    isRecording,
    initialPermissionMode: "allowAll",
    handleSubmit: wrappedHandleSubmit,
    supportsMultiAgentPromptSubmission: true,
  });

  const selectedAgent = modelToAgent(selectedModel);
  const credentialInfo = useCredentialInfoForAgent(selectedAgent);

  const isSubmitDisabled =
    baseIsSubmitDisabled || credentialInfo?.canInvokeAgent === false;

  // Set content when promptText changes
  React.useEffect(() => {
    if (props.promptText && editor) {
      editor.commands.setContent(props.promptText);
      editor.commands.focus();
    }
  }, [props.promptText, editor]);

  return (
    <div className="flex flex-col gap-6">
      <SimplePromptBox
        forcedAgent={null}
        forcedAgentVersion={null}
        editor={editor}
        attachedFiles={attachedFiles}
        handleFilesAttached={handleFilesAttached}
        removeFile={removeFile}
        isSubmitting={isSubmitting}
        submitForm={submitForm}
        handleStop={props.handleStop}
        isSubmitDisabled={isSubmitDisabled}
        showStopButton={false}
        hideSubmitButton={false}
        className="min-h-[140px]"
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        selectedModels={selectedModels}
        isMultiAgentMode={isMultiAgentMode}
        setIsMultiAgentMode={setIsMultiAgentMode}
        supportsMultiAgentPromptSubmission={true}
        onRecordingChange={setIsRecording}
        typeahead={repositoryCache}
        supportSaveAsDraft={true}
        supportSchedule={true}
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
      />
      <CredentialsWarning selectedModel={selectedModel} />
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between w-full gap-4 px-2">
        <RepoBranchSelector
          selectedRepoFullName={repoFullName || null}
          selectedBranch={branchName || null}
          onChange={onRepoBranchChange}
        />

        <div className="opacity-80 scale-95 origin-right">
          <PromptBoxToolBelt
            showSkipSetup={true}
            skipSetupValue={skipSetup}
            onSkipSetupChange={setSkipSetup}
            skipSetupDisabled={!repoFullName}
            showCheckpoint={true}
            checkpointValue={disableGitCheckpointing}
            onCheckpointChange={setDisableGitCheckpointing}
            checkpointDisabled={!repoFullName}
            showCreateNewBranchOption={true}
            createNewBranchValue={createNewBranch}
            onCreateNewBranchChange={setCreateNewBranch}
            createNewBranchDisabled={!repoFullName}
          />
        </div>
      </div>
    </div>
  );
}
