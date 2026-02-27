"use client";

import React, { useMemo, useState, useImperativeHandle } from "react";
import { usePromptBox, HandleSubmit, HandleStop } from "./use-promptbox";
import { useRepositoryCache } from "./typeahead/repository-cache";
import { isAgentStoppable, isAgentWorking } from "@/agent/thread-status";
import {
  ThreadStatus,
  DBUserMessage,
  GithubPRStatus,
  GithubCheckStatus,
} from "@terragon/shared";
import { AIAgent, AIModel } from "@terragon/agent/types";
import { SimplePromptBox } from "./simple-promptbox";
import { QueuedMessages } from "./queued-messages";
import { ensureAgent } from "@terragon/agent/utils";
import { GitHubQuickActions } from "../chat/github-quick-actions";

interface ThreadPromptBoxProps {
  placeholder?: string;
  threadId: string;
  threadChatId: string;
  sandboxId: string | null;
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
    if (!props.sandboxId) {
      // Only show "provisioning" message if agent is actually working
      if (props.status !== null && isAgentWorking(props.status)) {
        return "Sandbox is provisioning...";
      }
    }
    if (props.status !== null && isAgentWorking(props.status)) {
      return "Queue a message to send when agent is done";
    }
    return "Type your message here...";
  }, [props.placeholder, props.status, props.sandboxId]);

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
        className="min-h-[60px]"
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
