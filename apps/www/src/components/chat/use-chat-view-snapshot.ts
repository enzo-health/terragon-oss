"use client";

import { AIAgent } from "@terragon/agent/types";
import type {
  ThreadPageChat,
  ThreadPageShell,
} from "@terragon/shared/db/types";
import {
  DBMessage,
  DBUserMessage,
  ThreadChatInfoFull,
  ThreadInfoFull,
} from "@terragon/shared";
import { useMemo } from "react";
import { getLastUserMessageModel } from "@/lib/db-message-helpers";
import { createThreadViewSnapshot } from "./thread-view-model/snapshot-adapter";

/**
 * Builds the initial-user-message stub used by the redo-task dialog. Walks
 * leading user messages until a non-stop/error/meta event interrupts, then
 * returns their merged parts and earliest model selection.
 */
function getInitialUserMessage(messages: DBMessage[]): DBUserMessage {
  let messageModel: DBUserMessage["model"] = null;
  const initialUserMessage: DBUserMessage = {
    type: "user",
    model: null,
    parts: [],
  };

  for (const message of messages) {
    if (message.type === "user") {
      if (!messageModel && message.model) {
        messageModel = message.model;
        initialUserMessage.model = message.model;
      }
      initialUserMessage.parts.push(...message.parts);
      continue;
    }
    if (
      message.type === "stop" ||
      message.type === "error" ||
      message.type === "meta"
    ) {
      continue;
    }
    break;
  }

  return initialUserMessage;
}

/**
 * Derives the memoized read-side view objects consumed by `ChatUIContent`:
 * the synthesized full ThreadInfoFull, the preview chat row, the
 * thread-view snapshot, and the redo/fork dialog payloads. Pure presentation
 * — no React Query, no side effects — but keeps the parent component file
 * under the ≤400 LOC budget set by the chat-layer refactor plan.
 */
export function useChatViewSnapshot({
  shell,
  threadChat,
  threadDiff,
  threadChatSource,
  agent,
  capturedRunId,
  threadId,
}: {
  shell: ThreadPageShell;
  threadChat: ThreadPageChat;
  threadDiff:
    | {
        gitDiff: ThreadInfoFull["gitDiff"];
        gitDiffStats: ThreadInfoFull["gitDiffStats"];
      }
    | null
    | undefined;
  threadChatSource: "collection" | "react-query";
  agent: AIAgent;
  capturedRunId: string | null;
  threadId: string;
}) {
  const threadPreviewChat = useMemo<ThreadChatInfoFull>(
    () => ({
      id: shell.primaryThreadChat.id,
      userId: shell.userId,
      threadId: shell.id,
      title: null,
      createdAt: shell.createdAt,
      updatedAt: shell.primaryThreadChat.updatedAt,
      agent: shell.primaryThreadChat.agent,
      agentVersion: shell.primaryThreadChat.agentVersion,
      status: shell.primaryThreadChat.status,
      messages: [],
      queuedMessages: null,
      sessionId: null,
      errorMessage: shell.primaryThreadChat.errorMessage,
      errorMessageInfo: shell.primaryThreadChat.errorMessageInfo,
      scheduleAt: shell.primaryThreadChat.scheduleAt,
      reattemptQueueAt: shell.primaryThreadChat.reattemptQueueAt,
      contextLength: shell.primaryThreadChat.contextLength,
      permissionMode: shell.primaryThreadChat.permissionMode,
      codexPreviousResponseId: null,
      messageSeq: 0,
      isUnread: shell.primaryThreadChat.isUnread,
    }),
    [shell],
  );

  const thread = useMemo<ThreadInfoFull>(() => {
    const {
      hasGitDiff: _hasGitDiff,
      primaryThreadChatId: _primaryThreadChatId,
      primaryThreadChat: _primaryThreadChat,
      ...threadShell
    } = shell;
    return {
      ...threadShell,
      gitDiff: threadDiff?.gitDiff ?? null,
      gitDiffStats:
        threadDiff?.gitDiffStats ?? threadShell.gitDiffStats ?? null,
      threadChats: [threadPreviewChat],
      childThreads: shell.childThreads,
      parentThreadName: shell.parentThreadName,
    };
  }, [shell, threadDiff, threadPreviewChat]);

  const threadViewSnapshot = useMemo(
    () =>
      createThreadViewSnapshot({
        threadChat,
        agent,
        source: threadChatSource,
        artifactThread: {
          id: thread.id,
          updatedAt: thread.updatedAt,
          gitDiff: thread.gitDiff,
          gitDiffStats: thread.gitDiffStats ?? null,
        },
        githubSummary: {
          prStatus: thread.prStatus,
          prChecksStatus: thread.prChecksStatus,
          githubPRNumber: thread.githubPRNumber,
          githubRepoFullName: thread.githubRepoFullName,
        },
        runId: capturedRunId,
      }),
    [
      capturedRunId,
      agent,
      thread.gitDiff,
      thread.gitDiffStats,
      thread.githubPRNumber,
      thread.githubRepoFullName,
      thread.id,
      thread.prChecksStatus,
      thread.prStatus,
      thread.updatedAt,
      threadChat,
      threadChatSource,
    ],
  );

  const dbMessages = threadViewSnapshot.dbMessages;
  const lastUsedModel = useMemo(
    () => getLastUserMessageModel(dbMessages),
    [dbMessages],
  );
  const initialUserMessage = useMemo(
    () => getInitialUserMessage(dbMessages),
    [dbMessages],
  );

  const redoDialogData = useMemo(
    () => ({
      threadId,
      repoFullName: thread.githubRepoFullName ?? "",
      repoBaseBranchName: thread.repoBaseBranchName ?? "main",
      disableGitCheckpointing: thread.disableGitCheckpointing ?? false,
      skipSetup: thread.skipSetup ?? false,
      permissionMode: threadViewSnapshot.permissionMode ?? "allowAll",
      initialUserMessage,
    }),
    [
      initialUserMessage,
      thread.disableGitCheckpointing,
      thread.githubRepoFullName,
      thread.repoBaseBranchName,
      thread.skipSetup,
      threadViewSnapshot.permissionMode,
      threadId,
    ],
  );

  const forkDialogData = useMemo(
    () => ({
      threadId,
      threadChatId: threadChat.id,
      repoFullName: thread.githubRepoFullName ?? "",
      repoBaseBranchName: thread.repoBaseBranchName ?? "main",
      branchName: thread.branchName ?? null,
      gitDiffStats: thread.gitDiffStats ?? null,
      disableGitCheckpointing: thread.disableGitCheckpointing ?? false,
      skipSetup: thread.skipSetup ?? false,
      agent,
      lastSelectedModel: lastUsedModel,
    }),
    [
      agent,
      lastUsedModel,
      thread.branchName,
      thread.disableGitCheckpointing,
      thread.gitDiffStats,
      thread.githubRepoFullName,
      thread.repoBaseBranchName,
      thread.skipSetup,
      threadChat.id,
      threadId,
    ],
  );

  return {
    thread,
    threadViewSnapshot,
    lastUsedModel,
    redoDialogData,
    forkDialogData,
  };
}
