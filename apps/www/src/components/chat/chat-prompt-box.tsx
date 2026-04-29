"use client";

import { AIAgent } from "@terragon/agent/types";
import { ensureAgent } from "@terragon/agent/utils";
import type { BootingSubstatus } from "@terragon/sandbox/types";
import {
  DBUserMessage,
  GithubCheckStatus,
  GithubPRStatus,
  ThreadErrorMessage,
  ThreadStatus,
} from "@terragon/shared";
import React, { memo, useCallback } from "react";
import { ThreadPromptBox } from "@/components/promptbox/thread-promptbox";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import {
  convertToPlainText,
  getLastUserMessageModel,
} from "@/lib/db-message-helpers";
import { followUp, queueFollowUp } from "@/server-actions/follow-up";
import { stopThread } from "@/server-actions/stop-thread";
import { HandleSubmit } from "../promptbox/use-promptbox";
import { ContextChip } from "./context-chip";
import { ContextWarning } from "./context-warning";

export type ChatPromptBoxProps = {
  threadId: string;
  threadChatId: string;
  threadStatus: ThreadStatus | null;
  bootingSubstatus: BootingSubstatus | null;
  runStarted: boolean;
  queuedMessages: DBUserMessage[] | null;
  permissionMode: "allowAll" | "plan";
  prStatus: GithubPRStatus | null;
  prChecksStatus: GithubCheckStatus | null;
  githubPRNumber: number | null;
  sandboxId: string | null;
  repoFullName: string;
  branchName: string;
  agent: AIAgent;
  agentVersion: number;
  lastUsedModel: ReturnType<typeof getLastUserMessageModel>;
  contextLength: number | null;
  setError: (error: ThreadErrorMessage | null) => void;
  onOptimisticUserSubmit: (
    userMessage: DBUserMessage,
    optimisticStatus: ThreadStatus,
  ) => void;
  onOptimisticQueuedMessagesUpdate: (messages: DBUserMessage[]) => void;
  onPermissionModeChange: (mode: "allowAll" | "plan") => void;
  forceScrollToBottom: () => void;
  refetch: () => Promise<unknown>;
  promptBoxRef: React.RefObject<{
    focus: () => void;
    setPermissionMode: (mode: "allowAll" | "plan") => void;
  } | null>;
};

export const ChatPromptBox = memo(function ChatPromptBox({
  threadId,
  threadChatId,
  threadStatus,
  bootingSubstatus,
  runStarted,
  queuedMessages,
  permissionMode,
  prStatus,
  prChecksStatus,
  githubPRNumber,
  sandboxId,
  repoFullName,
  branchName,
  agent,
  agentVersion,
  lastUsedModel,
  contextLength,
  setError,
  onOptimisticUserSubmit,
  onOptimisticQueuedMessagesUpdate,
  onPermissionModeChange,
  refetch,
  forceScrollToBottom,
  promptBoxRef,
}: ChatPromptBoxProps) {
  const chatAgent = ensureAgent(agent);
  const showContextUsageChip = useFeatureFlag("contextUsageChip");

  const handleSubmit = useCallback<HandleSubmit>(
    async ({ userMessage }) => {
      const plainText = convertToPlainText({ message: userMessage });
      if (plainText.length === 0) {
        return;
      }
      forceScrollToBottom();
      setError(null);
      // Optimistically add the message to the thread
      const isClearContext = plainText.trim() === "/clear";
      const optimisticStatus = isClearContext ? "complete" : "booting";
      onOptimisticUserSubmit(userMessage, optimisticStatus);
      const followUpResult = await followUp({
        threadId,
        threadChatId,
        message: userMessage,
      });
      if (!followUpResult.success) {
        setError(followUpResult.errorMessage);
        await refetch();
        return;
      }
      if (isClearContext) {
        await refetch();
      }
    },
    [
      threadId,
      threadChatId,
      refetch,
      setError,
      forceScrollToBottom,
      onOptimisticUserSubmit,
    ],
  );

  const handleStop = useCallback(async () => {
    const stopResult = await stopThread({ threadId, threadChatId });
    if (!stopResult.success) {
      setError(stopResult.errorMessage);
      await refetch();
      return;
    }
    await refetch();
  }, [threadId, threadChatId, refetch, setError]);

  const updateQueuedMessages = useCallback(
    async (messages: DBUserMessage[]) => {
      onOptimisticQueuedMessagesUpdate(messages);
      const queueFollowUpResult = await queueFollowUp({
        threadId,
        threadChatId,
        messages,
      });
      if (!queueFollowUpResult.success) {
        setError(queueFollowUpResult.errorMessage);
        await refetch();
        return;
      }
      await refetch();
    },
    [
      threadId,
      threadChatId,
      refetch,
      setError,
      onOptimisticQueuedMessagesUpdate,
    ],
  );

  const handleQueueMessage = useCallback(
    async ({ userMessage }: { userMessage: DBUserMessage }) => {
      const plainText = convertToPlainText({ message: userMessage });
      if (plainText.length === 0) {
        return;
      }
      forceScrollToBottom();
      setError(null);
      updateQueuedMessages([...(queuedMessages ?? []), userMessage]);
    },
    [forceScrollToBottom, queuedMessages, setError, updateQueuedMessages],
  );

  return (
    <div className="z-10 bg-background chat-prompt-box px-6 pb-4 pt-3 max-w-chat w-full mx-auto">
      {showContextUsageChip ? (
        <ContextChip
          contextLength={contextLength}
          showAlways={chatAgent === "claudeCode"}
        />
      ) : (
        <ContextWarning contextLength={contextLength} />
      )}
      <ThreadPromptBox
        ref={promptBoxRef}
        threadId={threadId}
        threadChatId={threadChatId}
        status={threadStatus}
        bootingSubstatus={bootingSubstatus}
        runStarted={runStarted}
        prStatus={prStatus}
        prChecksStatus={prChecksStatus}
        githubPRNumber={githubPRNumber}
        sandboxId={sandboxId}
        repoFullName={repoFullName}
        branchName={branchName}
        agent={chatAgent}
        agentVersion={agentVersion}
        lastUsedModel={lastUsedModel}
        permissionMode={permissionMode}
        onPermissionModeChange={onPermissionModeChange}
        handleStop={handleStop}
        handleSubmit={handleSubmit}
        queuedMessages={queuedMessages}
        handleQueueMessage={handleQueueMessage}
        onUpdateQueuedMessage={updateQueuedMessages}
      />
    </div>
  );
});
