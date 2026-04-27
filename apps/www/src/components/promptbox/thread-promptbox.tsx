"use client";

import { AIAgent, AIModel } from "@terragon/agent/types";
import { ensureAgent } from "@terragon/agent/utils";
import type { BootingSubstatus } from "@terragon/sandbox/types";
import {
  DBUserMessage,
  GithubCheckStatus,
  GithubPRStatus,
  ThreadStatus,
} from "@terragon/shared";
import dynamic from "next/dynamic";
import React, {
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import {
  isAgentStoppable,
  isAgentWorking,
  isPreSandboxStatus,
} from "@/agent/thread-status";
import { SimplePromptBox } from "./simple-promptbox";
import { useRepositoryCache } from "./typeahead/repository-cache";
import { HandleStop, HandleSubmit, usePromptBox } from "./use-promptbox";

const QueuedMessages = dynamic(
  () => import("./queued-messages").then((mod) => mod.QueuedMessages),
  {
    loading: () => null,
  },
);

const GitHubQuickActions = dynamic(
  () =>
    import("../chat/github-quick-actions").then(
      (mod) => mod.GitHubQuickActions,
    ),
  {
    loading: () => null,
  },
);

interface ThreadPromptBoxProps {
  placeholder?: string;
  threadId: string;
  threadChatId: string;
  sandboxId: string | null;
  runStarted?: boolean;
  bootingSubstatus?: BootingSubstatus | null;
  status: ThreadStatus | null;
  repoFullName: string;
  branchName: string;
  prStatus: GithubPRStatus | null;
  prChecksStatus: GithubCheckStatus | null;
  githubPRNumber: number | null;
  agent: AIAgent;
  agentVersion: number;
  lastUsedModel: AIModel | null;
  permissionMode?: "allowAll" | "plan";
  onPermissionModeChange?: (mode: "allowAll" | "plan") => void;
  handleStop: HandleStop;
  handleSubmit: HandleSubmit;
  queuedMessages: DBUserMessage[] | null;
  handleQueueMessage: HandleSubmit;
  onUpdateQueuedMessage: (messages: DBUserMessage[]) => void;
}

export const WORKING_QUEUE_PLACEHOLDER =
  "Queue a message to send when agent is done";

export function getBootingPlaceholder(
  bootingSubstatus: BootingSubstatus | null | undefined,
  status: ThreadStatus | null,
): string {
  switch (bootingSubstatus) {
    case "provisioning":
    case "provisioning-done":
      return "Provisioning machine...";
    case "cloning-repo":
      return "Cloning repository...";
    case "installing-agent":
      return "Installing agent...";
    case "running-setup-script":
      return "Configuring environment...";
    case "booting-done":
      return "Waiting for assistant to start...";
    default:
      if (status === "booting") {
        return "Waiting for assistant to start...";
      }
      if (
        status === "queued" ||
        status === "queued-blocked" ||
        status === "queued-sandbox-creation-rate-limit" ||
        status === "queued-tasks-concurrency" ||
        status === "queued-agent-rate-limit"
      ) {
        return "Waiting in queue...";
      }
      return "Sandbox is provisioning...";
  }
}

export function shouldShowPreSandboxPlaceholder(params: {
  status: ThreadStatus | null;
  sandboxId: string | null;
  runStarted: boolean;
}): boolean {
  const { status, sandboxId, runStarted } = params;
  return (
    status !== null &&
    isPreSandboxStatus(status) &&
    sandboxId === null &&
    !runStarted
  );
}

export function getThreadPromptPlaceholder(params: {
  placeholder?: string;
  bootingSubstatus: BootingSubstatus | null | undefined;
  status: ThreadStatus | null;
  sandboxId: string | null;
  runStarted: boolean;
}): string {
  const { placeholder, bootingSubstatus, status, sandboxId, runStarted } =
    params;
  if (placeholder != null) {
    return placeholder;
  }
  if (shouldShowPreSandboxPlaceholder({ status, sandboxId, runStarted })) {
    return getBootingPlaceholder(bootingSubstatus, status);
  }
  if (status !== null && isAgentWorking(status)) {
    return WORKING_QUEUE_PLACEHOLDER;
  }
  return "Type your message here...";
}

export const ThreadPromptBox = React.forwardRef<
  { focus: () => void; setPermissionMode: (mode: "allowAll" | "plan") => void },
  ThreadPromptBoxProps
>((props, ref) => {
  const [isRecording, setIsRecording] = useState(false);
  const isWorking = props.status !== null && isAgentWorking(props.status);
  const repositoryCache = useRepositoryCache({
    repoFullName: props.repoFullName,
    branchName: props.branchName,
  });
  const forcedAgent = ensureAgent(props.agent);
  const placeholderText = useMemo(() => {
    return getThreadPromptPlaceholder({
      placeholder: props.placeholder,
      bootingSubstatus: props.bootingSubstatus,
      status: props.status,
      sandboxId: props.sandboxId,
      runStarted: !!props.runStarted,
    });
  }, [
    props.bootingSubstatus,
    props.placeholder,
    props.runStarted,
    props.sandboxId,
    props.status,
  ]);

  const shouldQueue = !!props.status && isAgentWorking(props.status);
  const {
    editor,
    attachedFiles,
    isSubmitting,
    isSubmitDisabled,
    handleFilesAttached,
    removeFile,
    submitForm,
    stopThread,
    permissionMode,
    setPermissionMode,
    selectedModel,
    setSelectedModel,
  } = usePromptBox({
    ...props,
    placeholderText,
    forcedAgent,
    forcedAgentVersion: props.agentVersion,
    initialSelectedModel: props.lastUsedModel,
    typeahead: repositoryCache,
    clearContentBeforeSubmit: true,
    requireRepoAndBranch: false,
    storageKeyPrefix: "prompt-box-input-thread",
    isAgentWorking: isWorking,
    isSandboxProvisioned: props.sandboxId != null,
    isQueueingEnabled: true,
    handleSubmit: shouldQueue ? props.handleQueueMessage : props.handleSubmit,
    isRecording,
    initialPermissionMode: props.permissionMode ?? "allowAll",
    supportsMultiAgentPromptSubmission: false,
  });

  const finalIsSubmitDisabled = isSubmitDisabled;
  const handlePermissionModeChange = useCallback(
    (mode: "allowAll" | "plan") => {
      setPermissionMode(mode);
      props.onPermissionModeChange?.(mode);
    },
    [props.onPermissionModeChange, setPermissionMode],
  );

  const showStopButton =
    props.threadId &&
    props.status &&
    isAgentStoppable(props.status) &&
    (!shouldQueue || editor?.isEmpty);

  // Expose editor focus and permission mode setter to parent
  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        editor?.commands.focus();
      },
      setPermissionMode: (mode: "allowAll" | "plan") => {
        handlePermissionModeChange(mode);
      },
    }),
    [editor, handlePermissionModeChange],
  );

  return (
    <div className="flex flex-col">
      {props.queuedMessages && props.queuedMessages.length > 0 && (
        <QueuedMessages
          agent={forcedAgent}
          messages={props.queuedMessages}
          onRemove={(idx) => {
            const newMessages = [...(props.queuedMessages || [])];
            newMessages.splice(idx, 1);
            props.onUpdateQueuedMessage?.(newMessages);
          }}
        />
      )}
      <GitHubQuickActions
        threadId={props.threadId}
        threadChatId={props.threadChatId}
        status={props.status}
        githubPRNumber={props.githubPRNumber}
        prStatus={props.prStatus}
        prChecksStatus={props.prChecksStatus}
        githubRepoFullName={props.repoFullName}
      />
      <SimplePromptBox
        editor={editor}
        attachedFiles={attachedFiles}
        handleFilesAttached={handleFilesAttached}
        removeFile={removeFile}
        isSubmitting={isSubmitting}
        submitForm={submitForm}
        handleStop={stopThread}
        isSubmitDisabled={finalIsSubmitDisabled}
        showStopButton={!!showStopButton}
        hideSubmitButton={false}
        className="min-h-[48px]"
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        selectedModels={{}}
        isMultiAgentMode={false}
        setIsMultiAgentMode={() => {}}
        supportsMultiAgentPromptSubmission={false}
        onRecordingChange={setIsRecording}
        forcedAgent={forcedAgent}
        forcedAgentVersion={props.agentVersion}
        typeahead={repositoryCache}
        permissionMode={permissionMode}
        onPermissionModeChange={handlePermissionModeChange}
      />
    </div>
  );
});

ThreadPromptBox.displayName = "ThreadPromptBox";
