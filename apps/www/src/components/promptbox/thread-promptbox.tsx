"use client";

import { AIAgent, AIModel } from "@terragon/agent/types";
import { ensureAgent } from "@terragon/agent/utils";
import {
  DBUserMessage,
  GithubCheckStatus,
  GithubPRStatus,
  ThreadStatus,
} from "@terragon/shared";
import dynamic from "next/dynamic";
import React, { useImperativeHandle, useMemo, useState } from "react";
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
  handleStop: HandleStop;
  handleSubmit: HandleSubmit;
  queuedMessages: DBUserMessage[] | null;
  handleQueueMessage: HandleSubmit;
  onUpdateQueuedMessage: (messages: DBUserMessage[]) => void;
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
    if (props.placeholder != null) {
      return props.placeholder;
    }
    // "Provisioning" should only appear before the sandbox boots. After that,
    // the server knows a sandbox exists even if the client prop hasn't been
    // updated yet (e.g. broadcast race, stale props).
    if (
      props.status !== null &&
      isPreSandboxStatus(props.status) &&
      props.sandboxId === null &&
      !props.runStarted
    ) {
      return "Sandbox is provisioning...";
    }
    if (props.status !== null && isAgentWorking(props.status)) {
      return "Queue a message to send when agent is done";
    }
    return "Type your message here...";
  }, [props.placeholder, props.runStarted, props.sandboxId, props.status]);

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
        setPermissionMode(mode);
      },
    }),
    [editor, setPermissionMode],
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
        onPermissionModeChange={setPermissionMode}
      />
    </div>
  );
});

ThreadPromptBox.displayName = "ThreadPromptBox";
