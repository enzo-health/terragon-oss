"use client";

import { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import {
  DBMessage,
  DBUserMessage,
  ThreadInfo,
  ThreadPageChat,
  ThreadPageShell,
  ThreadSourceMetadata,
} from "@terragon/shared";
import {
  BroadcastActiveChatRealtimeFields,
  BroadcastThreadPatch,
  BroadcastThreadShellRealtimeFields,
} from "@terragon/types/broadcast";
import {
  isMatchingThreadForFilter,
  isValidThreadListFilter,
  threadQueryKeys,
} from "./thread-queries";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDbMessage(value: unknown): value is DBMessage {
  return isRecord(value) && typeof value.type === "string";
}

function isDbMessageArray(value: unknown): value is DBMessage[] {
  return Array.isArray(value) && value.every(isDbMessage);
}

function isDbUserMessage(value: unknown): value is DBUserMessage {
  return isRecord(value) && value.type === "user" && Array.isArray(value.parts);
}

function isThreadSourceMetadata(
  value: unknown,
): value is ThreadSourceMetadata | null {
  if (value === null) {
    return true;
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  switch (value.type) {
    case "www":
    case "github-mention":
    case "slack-mention":
    case "www-fork":
    case "linear-mention":
    case "www-multi-agent":
      return true;
    default:
      return false;
  }
}

function toDbUserMessages(value: unknown): DBUserMessage[] | null | undefined {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value) || !value.every(isDbUserMessage)) {
    return undefined;
  }
  return value;
}

function toDateOrNull(
  value: string | null | undefined,
): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return new Date(value);
}

function applyShellFields(
  shell: ThreadPageShell,
  fields: BroadcastThreadShellRealtimeFields | undefined,
  patch: BroadcastThreadPatch,
): ThreadPageShell {
  if (!fields) {
    return shell;
  }

  const nextPrimaryThreadChatId =
    fields.primaryThreadChatId ?? shell.primaryThreadChatId;
  const primaryThreadChat =
    nextPrimaryThreadChatId === patch.threadChatId && patch.chat
      ? applyChatSummaryFields(shell.primaryThreadChat, patch.chat)
      : shell.primaryThreadChat;

  return {
    ...shell,
    ...(fields.userId !== undefined ? { userId: fields.userId } : {}),
    ...(fields.name !== undefined ? { name: fields.name } : {}),
    ...(fields.automationId !== undefined
      ? { automationId: fields.automationId }
      : {}),
    ...(fields.archived !== undefined ? { archived: fields.archived } : {}),
    ...(fields.visibility !== undefined
      ? { visibility: fields.visibility }
      : {}),
    ...(fields.isUnread !== undefined ? { isUnread: fields.isUnread } : {}),
    ...(fields.createdAt !== undefined
      ? { createdAt: new Date(fields.createdAt) }
      : {}),
    ...(fields.updatedAt !== undefined
      ? { updatedAt: new Date(fields.updatedAt) }
      : {}),
    ...(fields.branchName !== undefined
      ? { branchName: fields.branchName }
      : {}),
    ...(fields.repoBaseBranchName !== undefined
      ? { repoBaseBranchName: fields.repoBaseBranchName }
      : {}),
    ...(fields.githubRepoFullName !== undefined
      ? { githubRepoFullName: fields.githubRepoFullName }
      : {}),
    ...(fields.githubPRNumber !== undefined
      ? { githubPRNumber: fields.githubPRNumber }
      : {}),
    ...(fields.githubIssueNumber !== undefined
      ? { githubIssueNumber: fields.githubIssueNumber }
      : {}),
    ...(fields.prStatus !== undefined ? { prStatus: fields.prStatus } : {}),
    ...(fields.prChecksStatus !== undefined
      ? { prChecksStatus: fields.prChecksStatus }
      : {}),
    ...(fields.sandboxStatus !== undefined
      ? { sandboxStatus: fields.sandboxStatus }
      : {}),
    ...(fields.bootingSubstatus !== undefined
      ? { bootingSubstatus: fields.bootingSubstatus }
      : {}),
    ...(fields.codesandboxId !== undefined
      ? { codesandboxId: fields.codesandboxId }
      : {}),
    ...(fields.sandboxProvider != null
      ? { sandboxProvider: fields.sandboxProvider }
      : {}),
    ...(fields.sandboxSize !== undefined
      ? { sandboxSize: fields.sandboxSize }
      : {}),
    ...(fields.hasGitDiff !== undefined
      ? { hasGitDiff: fields.hasGitDiff }
      : {}),
    ...(fields.gitDiffStats !== undefined
      ? { gitDiffStats: fields.gitDiffStats }
      : {}),
    ...(fields.parentThreadId !== undefined
      ? { parentThreadId: fields.parentThreadId }
      : {}),
    ...(fields.parentThreadName !== undefined
      ? { parentThreadName: fields.parentThreadName }
      : {}),
    ...(fields.parentToolId !== undefined
      ? { parentToolId: fields.parentToolId }
      : {}),
    ...(fields.authorName !== undefined
      ? { authorName: fields.authorName }
      : {}),
    ...(fields.authorImage !== undefined
      ? { authorImage: fields.authorImage }
      : {}),
    ...(fields.draftMessage !== undefined &&
    (fields.draftMessage === null || isDbUserMessage(fields.draftMessage))
      ? { draftMessage: fields.draftMessage }
      : {}),
    ...(fields.skipSetup != null ? { skipSetup: fields.skipSetup } : {}),
    ...(fields.disableGitCheckpointing != null
      ? { disableGitCheckpointing: fields.disableGitCheckpointing }
      : {}),
    ...(fields.sourceType !== undefined
      ? { sourceType: fields.sourceType }
      : {}),
    ...(fields.sourceMetadata !== undefined &&
    isThreadSourceMetadata(fields.sourceMetadata)
      ? { sourceMetadata: fields.sourceMetadata }
      : {}),
    ...(fields.version !== undefined ? { version: fields.version } : {}),
    ...(fields.childThreads !== undefined
      ? { childThreads: fields.childThreads }
      : {}),
    sandboxProvider: fields.sandboxProvider ?? shell.sandboxProvider,
    primaryThreadChatId: nextPrimaryThreadChatId,
    primaryThreadChat,
  };
}

function applyChatSummaryFields(
  chat: ThreadPageShell["primaryThreadChat"],
  fields: BroadcastActiveChatRealtimeFields,
): ThreadPageShell["primaryThreadChat"] {
  return {
    ...chat,
    ...(fields.agent !== undefined ? { agent: fields.agent } : {}),
    ...(fields.agentVersion !== undefined
      ? { agentVersion: fields.agentVersion }
      : {}),
    ...(fields.status != null ? { status: fields.status } : {}),
    ...(fields.errorMessage !== undefined
      ? { errorMessage: fields.errorMessage }
      : {}),
    ...(fields.errorMessageInfo !== undefined
      ? { errorMessageInfo: fields.errorMessageInfo }
      : {}),
    ...(fields.scheduleAt !== undefined
      ? { scheduleAt: toDateOrNull(fields.scheduleAt) ?? null }
      : {}),
    ...(fields.reattemptQueueAt !== undefined
      ? { reattemptQueueAt: toDateOrNull(fields.reattemptQueueAt) ?? null }
      : {}),
    ...(fields.contextLength !== undefined
      ? { contextLength: fields.contextLength }
      : {}),
    ...(fields.permissionMode !== undefined
      ? { permissionMode: fields.permissionMode }
      : {}),
    ...(fields.isUnread !== undefined ? { isUnread: fields.isUnread } : {}),
    ...(fields.updatedAt !== undefined
      ? { updatedAt: new Date(fields.updatedAt) }
      : {}),
  };
}

/**
 * Monotonic integer sequences are always < 1 billion.
 * Timestamp-based sequences are ~1.7 trillion (milliseconds since epoch).
 */
function isMonotonicSequence(seq: number | null | undefined): boolean {
  return seq != null && seq < 1_000_000_000;
}

function getTranscriptMessages(chat: ThreadPageChat): DBMessage[] {
  return chat.projectedMessages ?? chat.messages ?? [];
}

function applyChatFields(
  chat: ThreadPageChat,
  patch: BroadcastThreadPatch,
): { chat: ThreadPageChat; shouldInvalidate: boolean; shouldIgnore: boolean } {
  if (patch.op === "refetch") {
    return {
      chat,
      shouldInvalidate: !(patch.refetch ?? []).includes("chat"),
      shouldIgnore: false,
    };
  }

  // Delta ops are ephemeral token-level streaming — handled by
  // delta accumulator in chat components, not the persistent cache.
  if (patch.op === "delta") {
    return { chat, shouldInvalidate: false, shouldIgnore: true };
  }

  const incomingMessageSeq = patch.messageSeq;
  const incomingPatchVersion = patch.patchVersion;
  const currentMessageSeq = chat.messageSeq;
  const currentPatchVersion = chat.patchVersion;

  // --- Legacy fallback: no dual seqs, use chatSequence ---
  if (incomingMessageSeq === undefined && incomingPatchVersion === undefined) {
    const incomingSequence = patch.chatSequence;
    const currentSequence = chat.chatSequence;

    // Optimistic pre-broadcast: no chatSequence means preview before DB write.
    // Always append without safety checks.
    if (
      incomingSequence === undefined &&
      patch.appendMessages !== undefined &&
      isDbMessageArray(patch.appendMessages) &&
      patch.appendMessages.length > 0
    ) {
      const nextMessages = [
        ...getTranscriptMessages(chat),
        ...patch.appendMessages,
      ];
      return {
        chat: applyPatchToChatObject(
          chat,
          patch,
          nextMessages,
          currentSequence ?? 0,
          currentMessageSeq ?? null,
          currentPatchVersion ?? null,
        ),
        shouldInvalidate: false,
        shouldIgnore: false,
      };
    }

    // Legacy monotonic chatSequence handling
    if (
      isMonotonicSequence(incomingSequence) &&
      isMonotonicSequence(currentSequence)
    ) {
      // Confirmation patch (no messages)
      if (
        patch.appendMessages === undefined ||
        patch.appendMessages.length === 0
      ) {
        if (incomingSequence! < currentSequence!) {
          return { chat, shouldInvalidate: false, shouldIgnore: true };
        }
        return {
          chat: applyPatchToChatObject(
            chat,
            patch,
            getTranscriptMessages(chat),
            incomingSequence!,
            currentMessageSeq ?? null,
            currentPatchVersion ?? null,
          ),
          shouldInvalidate: false,
          shouldIgnore: false,
        };
      }
      if (incomingSequence! <= currentSequence!) {
        return { chat, shouldInvalidate: false, shouldIgnore: true };
      }
      if (incomingSequence! > currentSequence! + 1) {
        return { chat, shouldInvalidate: true, shouldIgnore: false };
      }
      if (!isDbMessageArray(patch.appendMessages!)) {
        return { chat, shouldInvalidate: true, shouldIgnore: false };
      }
      const nextMessages = [
        ...getTranscriptMessages(chat),
        ...patch.appendMessages!,
      ];
      return {
        chat: applyPatchToChatObject(
          chat,
          patch,
          nextMessages,
          incomingSequence!,
          currentMessageSeq ?? null,
          currentPatchVersion ?? null,
        ),
        shouldInvalidate: false,
        shouldIgnore: false,
      };
    }

    // Unrecognized legacy state — invalidate
    return { chat, shouldInvalidate: true, shouldIgnore: false };
  }

  // --- Dual-seq path ---

  // 1. Message-carrying patch: use messageSeq for ordering
  if (
    patch.appendMessages !== undefined &&
    patch.appendMessages.length > 0 &&
    incomingMessageSeq !== undefined
  ) {
    // Duplicate or stale message
    if (currentMessageSeq != null && incomingMessageSeq <= currentMessageSeq) {
      // Still apply metadata if patchVersion is newer
      if (
        incomingPatchVersion !== undefined &&
        (currentPatchVersion == null ||
          incomingPatchVersion > currentPatchVersion)
      ) {
        return {
          chat: applyPatchToChatObject(
            chat,
            patch,
            getTranscriptMessages(chat),
            patch.chatSequence ?? chat.chatSequence,
            currentMessageSeq,
            incomingPatchVersion,
          ),
          shouldInvalidate: false,
          shouldIgnore: false,
        };
      }
      return { chat, shouldInvalidate: false, shouldIgnore: true };
    }
    // Gap detection
    if (
      currentMessageSeq != null &&
      incomingMessageSeq > currentMessageSeq + 1
    ) {
      return { chat, shouldInvalidate: true, shouldIgnore: false };
    }
    if (!isDbMessageArray(patch.appendMessages)) {
      return { chat, shouldInvalidate: true, shouldIgnore: false };
    }
    const nextMessages = [
      ...getTranscriptMessages(chat),
      ...patch.appendMessages,
    ];
    return {
      chat: applyPatchToChatObject(
        chat,
        patch,
        nextMessages,
        patch.chatSequence ?? chat.chatSequence,
        incomingMessageSeq,
        incomingPatchVersion ?? currentPatchVersion ?? null,
      ),
      shouldInvalidate: false,
      shouldIgnore: false,
    };
  }

  // 2. Metadata-only patch (status updates): use patchVersion for freshness
  if (incomingPatchVersion !== undefined) {
    if (
      currentPatchVersion != null &&
      incomingPatchVersion <= currentPatchVersion
    ) {
      return { chat, shouldInvalidate: false, shouldIgnore: true };
    }
    return {
      chat: applyPatchToChatObject(
        chat,
        patch,
        getTranscriptMessages(chat),
        patch.chatSequence ?? chat.chatSequence,
        incomingMessageSeq ?? currentMessageSeq ?? null,
        incomingPatchVersion,
      ),
      shouldInvalidate: false,
      shouldIgnore: false,
    };
  }

  // 3. Confirmation patch with messageSeq but no patchVersion (edge case)
  if (incomingMessageSeq !== undefined) {
    return {
      chat: applyPatchToChatObject(
        chat,
        patch,
        getTranscriptMessages(chat),
        patch.chatSequence ?? chat.chatSequence,
        incomingMessageSeq,
        currentPatchVersion ?? null,
      ),
      shouldInvalidate: false,
      shouldIgnore: false,
    };
  }

  // Fallback
  return { chat, shouldInvalidate: true, shouldIgnore: false };
}

function applyPatchToChatObject(
  chat: ThreadPageChat,
  patch: BroadcastThreadPatch,
  nextMessages: DBMessage[],
  chatSequence: number | null,
  messageSeq: number | null,
  patchVersion: number | null,
): ThreadPageChat {
  const queuedMessages = toDbUserMessages(patch.chat?.queuedMessages);
  return {
    ...chat,
    ...(patch.chat?.agent !== undefined ? { agent: patch.chat.agent } : {}),
    ...(patch.chat?.agentVersion !== undefined
      ? { agentVersion: patch.chat.agentVersion }
      : {}),
    ...(patch.chat?.status != null ? { status: patch.chat.status } : {}),
    ...(patch.chat?.errorMessage !== undefined
      ? { errorMessage: patch.chat.errorMessage }
      : {}),
    ...(patch.chat?.errorMessageInfo !== undefined
      ? { errorMessageInfo: patch.chat.errorMessageInfo }
      : {}),
    ...(patch.chat?.scheduleAt !== undefined
      ? { scheduleAt: toDateOrNull(patch.chat.scheduleAt) ?? null }
      : {}),
    ...(patch.chat?.reattemptQueueAt !== undefined
      ? { reattemptQueueAt: toDateOrNull(patch.chat.reattemptQueueAt) ?? null }
      : {}),
    ...(patch.chat?.contextLength !== undefined
      ? { contextLength: patch.chat.contextLength }
      : {}),
    ...(patch.chat?.permissionMode !== undefined
      ? { permissionMode: patch.chat.permissionMode }
      : {}),
    ...(patch.chat?.isUnread !== undefined
      ? { isUnread: patch.chat.isUnread }
      : {}),
    ...(patch.chat?.updatedAt !== undefined
      ? { updatedAt: new Date(patch.chat.updatedAt) }
      : {}),
    ...(queuedMessages !== undefined ? { queuedMessages } : {}),
    projectedMessages: nextMessages,
    messageCount: nextMessages.length,
    chatSequence,
    messageSeq: messageSeq ?? 0,
    patchVersion,
  };
}

function threadShellToListThread(shell: ThreadPageShell): ThreadInfo {
  return {
    id: shell.id,
    userId: shell.userId,
    name: shell.name,
    githubRepoFullName: shell.githubRepoFullName,
    githubPRNumber: shell.githubPRNumber,
    githubIssueNumber: shell.githubIssueNumber,
    codesandboxId: shell.codesandboxId,
    sandboxProvider: shell.sandboxProvider,
    sandboxSize: shell.sandboxSize,
    sandboxStatus: shell.sandboxStatus,
    bootingSubstatus: shell.bootingSubstatus,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
    repoBaseBranchName: shell.repoBaseBranchName,
    branchName: shell.branchName,
    archived: shell.archived,
    automationId: shell.automationId,
    parentThreadId: shell.parentThreadId,
    parentToolId: shell.parentToolId,
    draftMessage: shell.draftMessage,
    disableGitCheckpointing: shell.disableGitCheckpointing,
    skipSetup: shell.skipSetup,
    sourceType: shell.sourceType,
    sourceMetadata: shell.sourceMetadata,
    version: shell.version,
    gitDiffStats: shell.gitDiffStats,
    authorName: shell.authorName,
    authorImage: shell.authorImage,
    prStatus: shell.prStatus,
    prChecksStatus: shell.prChecksStatus,
    visibility: shell.visibility,
    isUnread: shell.isUnread,
    messageSeq: shell.messageSeq,
    threadChats: [
      {
        id: shell.primaryThreadChat.id,
        agent: shell.primaryThreadChat.agent,
        status: shell.primaryThreadChat.status,
        errorMessage: shell.primaryThreadChat.errorMessage,
      },
    ],
  };
}

export function threadPatchToListThread(
  patch: BroadcastThreadPatch,
  fallbackThread?: ThreadInfo,
): ThreadInfo | undefined {
  const shell = patch.shell;
  if (!shell?.userId) {
    return undefined;
  }
  const threadChatId = patch.threadChatId ?? shell.primaryThreadChatId;
  const draftMessage =
    shell.draftMessage === null
      ? null
      : isDbUserMessage(shell.draftMessage)
        ? shell.draftMessage
        : (fallbackThread?.draftMessage ?? null);
  const sourceMetadata =
    shell.sourceMetadata !== undefined &&
    isThreadSourceMetadata(shell.sourceMetadata)
      ? shell.sourceMetadata
      : (fallbackThread?.sourceMetadata ?? null);
  const threadChats =
    fallbackThread?.threadChats ??
    (threadChatId
      ? [
          {
            id: threadChatId,
            agent: patch.chat?.agent ?? "claudeCode",
            status: patch.chat?.status ?? "complete",
            errorMessage: patch.chat?.errorMessage ?? null,
          },
        ]
      : []);

  return {
    id: patch.threadId,
    userId: shell.userId,
    name: shell.name ?? fallbackThread?.name ?? null,
    githubRepoFullName:
      shell.githubRepoFullName ?? fallbackThread?.githubRepoFullName ?? "",
    githubPRNumber:
      shell.githubPRNumber ?? fallbackThread?.githubPRNumber ?? null,
    githubIssueNumber:
      shell.githubIssueNumber ?? fallbackThread?.githubIssueNumber ?? null,
    codesandboxId: shell.codesandboxId ?? fallbackThread?.codesandboxId ?? null,
    sandboxProvider:
      shell.sandboxProvider ?? fallbackThread?.sandboxProvider ?? "e2b",
    sandboxSize: shell.sandboxSize ?? fallbackThread?.sandboxSize ?? null,
    sandboxStatus: shell.sandboxStatus ?? fallbackThread?.sandboxStatus ?? null,
    bootingSubstatus:
      shell.bootingSubstatus ?? fallbackThread?.bootingSubstatus ?? null,
    createdAt: shell.createdAt
      ? new Date(shell.createdAt)
      : (fallbackThread?.createdAt ?? new Date()),
    updatedAt: shell.updatedAt
      ? new Date(shell.updatedAt)
      : (fallbackThread?.updatedAt ?? new Date()),
    repoBaseBranchName:
      shell.repoBaseBranchName ?? fallbackThread?.repoBaseBranchName ?? "main",
    branchName: shell.branchName ?? fallbackThread?.branchName ?? null,
    archived: shell.archived ?? fallbackThread?.archived ?? false,
    automationId: shell.automationId ?? fallbackThread?.automationId ?? null,
    parentThreadId:
      shell.parentThreadId ?? fallbackThread?.parentThreadId ?? null,
    parentToolId: shell.parentToolId ?? fallbackThread?.parentToolId ?? null,
    draftMessage,
    disableGitCheckpointing:
      shell.disableGitCheckpointing ??
      fallbackThread?.disableGitCheckpointing ??
      false,
    skipSetup: shell.skipSetup ?? fallbackThread?.skipSetup ?? false,
    sourceType: shell.sourceType ?? fallbackThread?.sourceType ?? "www",
    sourceMetadata,
    version: shell.version ?? fallbackThread?.version ?? 1,
    gitDiffStats: shell.gitDiffStats ?? fallbackThread?.gitDiffStats ?? null,
    authorName: shell.authorName ?? fallbackThread?.authorName ?? null,
    authorImage: shell.authorImage ?? fallbackThread?.authorImage ?? null,
    prStatus: shell.prStatus ?? fallbackThread?.prStatus ?? null,
    prChecksStatus:
      shell.prChecksStatus ?? fallbackThread?.prChecksStatus ?? null,
    visibility: shell.visibility ?? fallbackThread?.visibility ?? null,
    isUnread: shell.isUnread ?? fallbackThread?.isUnread ?? false,
    messageSeq: fallbackThread?.messageSeq ?? 0,
    threadChats,
  };
}

export function applyThreadPatchToListThread(
  thread: ThreadInfo,
  patch: BroadcastThreadPatch,
): ThreadInfo {
  let threadChats = thread.threadChats;
  const chatUpdatedAt =
    patch.chat?.updatedAt !== undefined
      ? new Date(patch.chat.updatedAt)
      : undefined;
  const shouldBumpFromChat =
    chatUpdatedAt !== undefined &&
    chatUpdatedAt.getTime() > thread.updatedAt.getTime();
  if (patch.threadChatId && patch.chat) {
    const hasVisibleChatFields =
      patch.chat.agent !== undefined ||
      patch.chat.status !== undefined ||
      patch.chat.errorMessage !== undefined;
    if (hasVisibleChatFields) {
      const existingIndex = threadChats.findIndex(
        (chat) => chat.id === patch.threadChatId,
      );
      const existingChat =
        existingIndex >= 0 ? threadChats[existingIndex] : undefined;
      const nextChat = {
        id: patch.threadChatId,
        agent: patch.chat.agent ?? existingChat?.agent ?? "claudeCode",
        status: patch.chat.status ?? existingChat?.status ?? "queued",
        errorMessage:
          patch.chat.errorMessage ?? existingChat?.errorMessage ?? null,
      };
      const isUnchanged =
        existingChat !== undefined &&
        existingChat.id === nextChat.id &&
        existingChat.agent === nextChat.agent &&
        existingChat.status === nextChat.status &&
        existingChat.errorMessage === nextChat.errorMessage;
      if (!isUnchanged) {
        if (existingIndex >= 0) {
          threadChats = [...threadChats];
          threadChats[existingIndex] = nextChat;
        } else {
          threadChats = [nextChat, ...threadChats];
        }
      }
    }
  }

  if (!patch.shell) {
    if (!shouldBumpFromChat && threadChats === thread.threadChats) {
      return thread;
    }
    return {
      ...thread,
      ...(threadChats !== thread.threadChats ? { threadChats } : {}),
      ...(shouldBumpFromChat ? { updatedAt: chatUpdatedAt } : {}),
    };
  }

  const shellUpdatedAt =
    patch.shell.updatedAt !== undefined
      ? new Date(patch.shell.updatedAt)
      : undefined;
  const nextUpdatedAt =
    shellUpdatedAt !== undefined && chatUpdatedAt !== undefined
      ? shellUpdatedAt.getTime() > chatUpdatedAt.getTime()
        ? shellUpdatedAt
        : chatUpdatedAt
      : (shellUpdatedAt ?? (shouldBumpFromChat ? chatUpdatedAt : undefined));

  return {
    ...thread,
    ...(patch.shell?.userId !== undefined
      ? { userId: patch.shell.userId }
      : {}),
    ...(patch.shell?.name !== undefined ? { name: patch.shell.name } : {}),
    ...(patch.shell?.automationId !== undefined
      ? { automationId: patch.shell.automationId }
      : {}),
    ...(patch.shell?.archived !== undefined
      ? { archived: patch.shell.archived }
      : {}),
    ...(patch.shell?.visibility !== undefined
      ? { visibility: patch.shell.visibility }
      : {}),
    ...(patch.shell?.isUnread !== undefined
      ? { isUnread: patch.shell.isUnread }
      : {}),
    ...(patch.shell?.createdAt !== undefined
      ? { createdAt: new Date(patch.shell.createdAt) }
      : {}),
    ...(nextUpdatedAt !== undefined ? { updatedAt: nextUpdatedAt } : {}),
    ...(patch.shell?.branchName !== undefined
      ? { branchName: patch.shell.branchName }
      : {}),
    ...(patch.shell?.repoBaseBranchName !== undefined
      ? { repoBaseBranchName: patch.shell.repoBaseBranchName }
      : {}),
    ...(patch.shell?.githubRepoFullName !== undefined
      ? { githubRepoFullName: patch.shell.githubRepoFullName }
      : {}),
    ...(patch.shell?.githubPRNumber !== undefined
      ? { githubPRNumber: patch.shell.githubPRNumber }
      : {}),
    ...(patch.shell?.githubIssueNumber !== undefined
      ? { githubIssueNumber: patch.shell.githubIssueNumber }
      : {}),
    ...(patch.shell?.prStatus !== undefined
      ? { prStatus: patch.shell.prStatus }
      : {}),
    ...(patch.shell?.prChecksStatus !== undefined
      ? { prChecksStatus: patch.shell.prChecksStatus }
      : {}),
    ...(patch.shell?.sandboxStatus !== undefined
      ? { sandboxStatus: patch.shell.sandboxStatus }
      : {}),
    ...(patch.shell?.bootingSubstatus !== undefined
      ? { bootingSubstatus: patch.shell.bootingSubstatus }
      : {}),
    ...(patch.shell?.codesandboxId !== undefined
      ? { codesandboxId: patch.shell.codesandboxId }
      : {}),
    ...(patch.shell?.sandboxProvider != null
      ? { sandboxProvider: patch.shell.sandboxProvider }
      : {}),
    ...(patch.shell?.sandboxSize != null
      ? { sandboxSize: patch.shell.sandboxSize }
      : {}),
    ...(patch.shell?.gitDiffStats !== undefined
      ? { gitDiffStats: patch.shell.gitDiffStats }
      : {}),
    ...(patch.shell?.parentThreadId !== undefined
      ? { parentThreadId: patch.shell.parentThreadId }
      : {}),
    ...(patch.shell?.parentToolId !== undefined
      ? { parentToolId: patch.shell.parentToolId }
      : {}),
    ...(patch.shell?.draftMessage !== undefined &&
    (patch.shell.draftMessage === null ||
      isDbUserMessage(patch.shell.draftMessage))
      ? { draftMessage: patch.shell.draftMessage }
      : {}),
    ...(patch.shell?.skipSetup != null
      ? { skipSetup: patch.shell.skipSetup }
      : {}),
    ...(patch.shell?.disableGitCheckpointing != null
      ? {
          disableGitCheckpointing: patch.shell.disableGitCheckpointing,
        }
      : {}),
    ...(patch.shell?.sourceType !== undefined
      ? { sourceType: patch.shell.sourceType }
      : {}),
    ...(patch.shell?.sourceMetadata !== undefined &&
    isThreadSourceMetadata(patch.shell.sourceMetadata)
      ? { sourceMetadata: patch.shell.sourceMetadata }
      : {}),
    ...(patch.shell?.version !== undefined
      ? { version: patch.shell.version }
      : {}),
    ...(patch.shell?.authorName !== undefined
      ? { authorName: patch.shell.authorName }
      : {}),
    ...(patch.shell?.authorImage !== undefined
      ? { authorImage: patch.shell.authorImage }
      : {}),
    sandboxProvider: patch.shell.sandboxProvider ?? thread.sandboxProvider,
    threadChats,
  };
}

function findThreadInListQueries(
  queryClient: QueryClient,
  threadId: string,
): ThreadInfo | undefined {
  const listQueries = queryClient
    .getQueryCache()
    .findAll({ queryKey: threadQueryKeys.list(null) });

  for (const query of listQueries) {
    const data = query.state.data as InfiniteData<ThreadInfo[]> | undefined;
    const thread = data?.pages
      .flatMap((page) => page)
      .find((item) => item.id === threadId);
    if (thread) {
      return thread;
    }
  }

  return undefined;
}

function updateThreadListQueries(
  queryClient: QueryClient,
  patch: BroadcastThreadPatch,
  shellSnapshot?: ThreadPageShell,
): { didFindThreadInAnyQuery: boolean } {
  const listQueries = queryClient
    .getQueryCache()
    .findAll({ queryKey: threadQueryKeys.list(null) });
  const cachedBaseThread = findThreadInListQueries(queryClient, patch.threadId);
  const shellBaseThread = shellSnapshot
    ? threadShellToListThread(shellSnapshot)
    : patch.shell
      ? threadPatchToListThread(patch, cachedBaseThread)
      : undefined;
  let didFindThreadInAnyQuery = cachedBaseThread !== undefined;

  for (const query of listQueries) {
    const queryKey = query.queryKey as QueryKey;
    const filters = queryKey.length > 2 ? (queryKey[2] as unknown) : undefined;

    queryClient.setQueryData<InfiniteData<ThreadInfo[]>>(
      queryKey,
      (oldData) => {
        if (!oldData) {
          return oldData;
        }

        if (patch.op === "delete") {
          let didChangeQuery = false;
          const pages = oldData.pages.map((page) => {
            const nextPage = page.filter(
              (thread) => thread.id !== patch.threadId,
            );
            if (nextPage.length !== page.length) {
              didChangeQuery = true;
              didFindThreadInAnyQuery = true;
              return nextPage;
            }
            return page;
          });
          return didChangeQuery ? { ...oldData, pages } : oldData;
        }

        let didFindThreadInQuery = false;
        let didChangeQuery = false;
        const pages = oldData.pages.map((page) => {
          let pageChanged = false;
          const nextPage = page.flatMap((thread) => {
            if (thread.id !== patch.threadId) {
              return [thread];
            }
            didFindThreadInQuery = true;
            didFindThreadInAnyQuery = true;
            const nextThread = applyThreadPatchToListThread(thread, patch);
            if (
              isValidThreadListFilter(filters) &&
              !isMatchingThreadForFilter(nextThread, filters)
            ) {
              pageChanged = true;
              return [];
            }
            if (nextThread !== thread) {
              pageChanged = true;
            }
            return [nextThread];
          });
          if (pageChanged) {
            didChangeQuery = true;
            return nextPage;
          }
          return page;
        });

        if (!didFindThreadInQuery && shellBaseThread) {
          const nextThread = applyThreadPatchToListThread(
            shellBaseThread,
            patch,
          );
          if (
            nextThread &&
            (!isValidThreadListFilter(filters) ||
              isMatchingThreadForFilter(nextThread, filters))
          ) {
            const [firstPage, ...restPages] = pages;
            didChangeQuery = true;
            return {
              ...oldData,
              pages: [[nextThread, ...(firstPage ?? [])], ...restPages],
            };
          }
        }

        return didChangeQuery ? { ...oldData, pages } : oldData;
      },
    );
  }

  return { didFindThreadInAnyQuery };
}

function shouldInvalidateListRefetch(patch: BroadcastThreadPatch): boolean {
  return (
    (patch.refetch ?? []).includes("list") &&
    patch.op !== "delete" &&
    patch.shell === undefined
  );
}

export function invalidateThreadPatchRefetchTargets(
  queryClient: QueryClient,
  patch: BroadcastThreadPatch,
  options?: {
    includeList?: boolean;
  },
) {
  for (const target of patch.refetch ?? []) {
    switch (target) {
      case "shell":
        queryClient.invalidateQueries({
          queryKey: threadQueryKeys.shell(patch.threadId),
        });
        break;
      case "chat":
        if (patch.threadChatId) {
          queryClient.invalidateQueries({
            queryKey: threadQueryKeys.chat(patch.threadId, patch.threadChatId),
          });
        }
        break;
      case "diff":
        queryClient.invalidateQueries({
          queryKey: threadQueryKeys.diff(patch.threadId),
        });
        break;
      case "list":
        if (options?.includeList ?? true) {
          queryClient.invalidateQueries({
            queryKey: threadQueryKeys.list(null),
          });
        }
        break;
    }
  }
}

export function applyThreadPatchToListQueries({
  queryClient,
  patch,
}: {
  queryClient: QueryClient;
  patch: BroadcastThreadPatch;
}) {
  updateThreadListQueries(queryClient, patch);
  invalidateThreadPatchRefetchTargets(queryClient, patch, {
    includeList: shouldInvalidateListRefetch(patch),
  });
}

export function applyThreadPatchToQueryClient({
  queryClient,
  patch,
}: {
  queryClient: QueryClient;
  patch: BroadcastThreadPatch;
}) {
  if (patch.op === "delete") {
    queryClient.removeQueries({
      queryKey: threadQueryKeys.shell(patch.threadId),
    });
    queryClient.removeQueries({
      queryKey: ["threads", "chat", patch.threadId],
    });
    queryClient.removeQueries({
      queryKey: threadQueryKeys.diff(patch.threadId),
    });
    updateThreadListQueries(queryClient, patch);
    invalidateThreadPatchRefetchTargets(queryClient, patch, {
      includeList: false,
    });
    return;
  }

  let shellSnapshot: ThreadPageShell | undefined;
  let previousPrimaryThreadChatId: string | undefined;
  let nextPrimaryThreadChatId: string | undefined;
  let shouldRefreshShellForPrimarySwitch = false;
  queryClient.setQueryData<ThreadPageShell>(
    threadQueryKeys.shell(patch.threadId),
    (oldShell) => {
      if (!oldShell) {
        return oldShell;
      }
      previousPrimaryThreadChatId = oldShell.primaryThreadChatId;
      shouldRefreshShellForPrimarySwitch =
        patch.threadChatId !== undefined &&
        patch.threadChatId !== oldShell.primaryThreadChatId &&
        patch.shell?.primaryThreadChatId === undefined;
      const nextShell = applyShellFields(oldShell, patch.shell, patch);
      nextPrimaryThreadChatId = nextShell.primaryThreadChatId;
      shellSnapshot = nextShell;
      return nextShell;
    },
  );

  if (patch.threadChatId) {
    const chatQueryKey = threadQueryKeys.chat(
      patch.threadId,
      patch.threadChatId,
    );
    let shouldInvalidateChat = false;
    let shouldIgnorePatch = false;

    queryClient.setQueryData<ThreadPageChat>(chatQueryKey, (oldChat) => {
      if (!oldChat) {
        return oldChat;
      }
      const result = applyChatFields(oldChat, patch);
      shouldInvalidateChat = result.shouldInvalidate;
      shouldIgnorePatch = result.shouldIgnore;
      return result.chat;
    });

    const shouldInvalidateDiffBeforeIgnore =
      patch.diffChanged || (patch.refetch ?? []).includes("diff");
    if (shouldIgnorePatch) {
      if (shouldInvalidateDiffBeforeIgnore) {
        queryClient.invalidateQueries({
          queryKey: threadQueryKeys.diff(patch.threadId),
        });
      }
      return;
    }
    if (shouldInvalidateChat) {
      queryClient.invalidateQueries({ queryKey: chatQueryKey });
    }
  }

  if (patch.diffChanged) {
    queryClient.invalidateQueries({
      queryKey: threadQueryKeys.diff(patch.threadId),
    });
  }
  if (shouldRefreshShellForPrimarySwitch) {
    queryClient.invalidateQueries({
      queryKey: threadQueryKeys.shell(patch.threadId),
    });
  }

  updateThreadListQueries(queryClient, patch, shellSnapshot);
  invalidateThreadPatchRefetchTargets(queryClient, patch, {
    includeList: false,
  });

  if (
    nextPrimaryThreadChatId &&
    nextPrimaryThreadChatId !== previousPrimaryThreadChatId
  ) {
    queryClient.invalidateQueries({
      queryKey: threadQueryKeys.chat(patch.threadId, nextPrimaryThreadChatId),
    });
  }
}
