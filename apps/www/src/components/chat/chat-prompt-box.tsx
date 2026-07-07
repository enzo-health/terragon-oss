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
import React, { memo, useCallback, useMemo } from "react";
import { ThreadPromptBox } from "@/components/promptbox/thread-promptbox";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { useThreadIntent } from "@/hooks/use-thread-intent";
import {
  convertToPlainText,
  getLastUserMessageModel,
} from "@/lib/db-message-helpers";
import type { ComposerOptimisticSubmit } from "../promptbox/composer-submit-routing";
import type {
  HandleSubmit,
  HandleSubmitArgs,
} from "../promptbox/use-promptbox";
import { ContextChip } from "./context-chip";
import { ContextWarning } from "./context-warning";
import { appendUniqueQueuedMessages } from "./queued-message-dedupe";

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
    clientSubmissionId: string,
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

  const { publish } = useThreadIntent();

  const handleSubmit = useCallback<HandleSubmit>(
    async ({ userMessage, clientSubmissionId }) => {
      const plainText = convertToPlainText({ message: userMessage });
      if (plainText.length === 0) {
        return;
      }
      forceScrollToBottom();
      setError(null);
      // The optimistic flip is hoisted into routeComposerSubmit, which fires it
      // on every non-queue route before this fallback runs, so this path only
      // publishes the message.
      const isClearContext = plainText.trim() === "/clear";
      try {
        await publish({
          type: "send-message",
          threadId,
          threadChatId,
          message: userMessage,
          clientSubmissionId,
        });
      } catch {
        await refetch();
        return;
      }
      if (isClearContext) {
        await refetch();
      }
    },
    [threadId, threadChatId, refetch, setError, forceScrollToBottom, publish],
  );

  // The optimistic flip (booting + optimistic user bubble) hoisted above the
  // composer routing fork so it fires on the runtime.append path too, opening
  // the resume stream without a refresh. The /clear -> 'complete' status
  // special-case lives here so the router stays status-agnostic.
  const optimisticSubmit = useMemo<ComposerOptimisticSubmit>(() => {
    return ({ userMessage, clientSubmissionId }) => {
      const plainText = convertToPlainText({ message: userMessage });
      if (plainText.length === 0) {
        return;
      }
      forceScrollToBottom();
      setError(null);
      const isClearContext = plainText.trim() === "/clear";
      const optimisticStatus: ThreadStatus = isClearContext
        ? "complete"
        : "booting";
      onOptimisticUserSubmit(userMessage, optimisticStatus, clientSubmissionId);
    };
  }, [forceScrollToBottom, setError, onOptimisticUserSubmit]);

  const handleStop = useCallback(async () => {
    try {
      await publish({
        type: "stop-thread",
        threadId,
        threadChatId,
      });
    } catch {
      await refetch();
      return;
    }
    await refetch();
  }, [threadId, threadChatId, refetch, publish]);

  const updateQueuedMessages = useCallback(
    async (messages: DBUserMessage[]) => {
      onOptimisticQueuedMessagesUpdate(messages);
      try {
        await publish({
          type: "queue-message",
          threadId,
          threadChatId,
          messages,
        });
      } catch {
        await refetch();
        return;
      }
      await refetch();
    },
    [
      threadId,
      threadChatId,
      refetch,
      publish,
      onOptimisticQueuedMessagesUpdate,
    ],
  );

  const handleQueueMessage = useCallback(
    async ({ userMessage, clientSubmissionId }: HandleSubmitArgs) => {
      const plainText = convertToPlainText({ message: userMessage });
      if (plainText.length === 0) {
        return;
      }
      forceScrollToBottom();
      setError(null);
      const baseQueuedMessages = queuedMessages ?? [];
      const nextMessages = appendUniqueQueuedMessages(baseQueuedMessages, [
        {
          clientSubmissionId,
          message: userMessage,
        },
      ]);
      if (nextMessages === baseQueuedMessages) {
        return;
      }
      await updateQueuedMessages(nextMessages);
    },
    [forceScrollToBottom, queuedMessages, setError, updateQueuedMessages],
  );

  return (
    <div className="z-10 bg-card chat-prompt-box px-4 pb-3 pt-2 max-w-chat w-full mx-auto">
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
        optimisticSubmit={optimisticSubmit}
        queuedMessages={queuedMessages}
        handleQueueMessage={handleQueueMessage}
        onUpdateQueuedMessage={updateQueuedMessages}
      />
    </div>
  );
});
