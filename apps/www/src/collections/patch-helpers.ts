/**
 * Pure functions for applying BroadcastThreadPatch fields to shell and chat objects.
 * Extracted from thread-patch-cache.ts for reuse by TanStack DB collections.
 */

import {
  ThreadPageShell,
  ThreadPageChat,
  ThreadSourceMetadata,
} from "@terragon/shared/db/types";
import { DBMessage, DBUserMessage } from "@terragon/shared";
import {
  BroadcastThreadPatch,
  BroadcastThreadShellRealtimeFields,
  BroadcastActiveChatRealtimeFields,
} from "@terragon/types/broadcast";

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
  if (value === null) return true;
  if (!isRecord(value) || typeof value.type !== "string") return false;
  return [
    "www",
    "github-mention",
    "slack-mention",
    "www-fork",
    "linear-mention",
    "www-multi-agent",
  ].includes(value.type as string);
}

function toDbUserMessages(value: unknown): DBUserMessage[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || !value.every(isDbUserMessage)) return undefined;
  return value;
}

function toDateOrNull(
  value: string | null | undefined,
): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}

function isMonotonicSequence(seq: number | null | undefined): boolean {
  return seq != null && seq < 1_000_000_000;
}

export function applyChatSummaryPatchFields(
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

export function applyShellPatchFields(
  shell: ThreadPageShell,
  fields: BroadcastThreadShellRealtimeFields | undefined,
  patch: BroadcastThreadPatch,
): ThreadPageShell {
  if (!fields) return shell;

  const nextPrimaryThreadChatId =
    fields.primaryThreadChatId ?? shell.primaryThreadChatId;
  const primaryThreadChat =
    nextPrimaryThreadChatId === patch.threadChatId && patch.chat
      ? applyChatSummaryPatchFields(shell.primaryThreadChat, patch.chat)
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

export type ChatPatchResult = {
  action: "apply" | "invalidate" | "ignore";
  nextChat?: ThreadPageChat;
};

export function validateChatPatch(
  chat: ThreadPageChat,
  patch: BroadcastThreadPatch,
): ChatPatchResult {
  if (patch.op === "refetch") {
    return {
      action: !(patch.refetch ?? []).includes("chat") ? "invalidate" : "ignore",
    };
  }
  if (patch.op === "delta") return { action: "ignore" };

  const incomingMessageSeq = patch.messageSeq;
  const incomingPatchVersion = patch.patchVersion;
  const currentMessageSeq = chat.messageSeq;
  const currentPatchVersion = chat.patchVersion;

  // Legacy fallback: no dual seqs
  if (incomingMessageSeq === undefined && incomingPatchVersion === undefined) {
    const incomingSequence = patch.chatSequence;
    const currentSequence = chat.chatSequence;

    if (
      incomingSequence === undefined &&
      patch.appendMessages !== undefined &&
      isDbMessageArray(patch.appendMessages) &&
      patch.appendMessages.length > 0
    ) {
      const nextMessages = [...(chat.messages ?? []), ...patch.appendMessages];
      return {
        action: "apply",
        nextChat: buildChatObject(
          chat,
          patch,
          nextMessages,
          currentSequence ?? 0,
          currentMessageSeq ?? null,
          currentPatchVersion ?? null,
        ),
      };
    }

    if (
      isMonotonicSequence(incomingSequence) &&
      isMonotonicSequence(currentSequence)
    ) {
      if (!patch.appendMessages?.length) {
        return incomingSequence! < currentSequence!
          ? { action: "ignore" }
          : {
              action: "apply",
              nextChat: buildChatObject(
                chat,
                patch,
                chat.messages ?? [],
                incomingSequence!,
                currentMessageSeq ?? null,
                currentPatchVersion ?? null,
              ),
            };
      }
      if (incomingSequence! <= currentSequence!) return { action: "ignore" };
      if (incomingSequence! > currentSequence! + 1)
        return { action: "invalidate" };
      if (!isDbMessageArray(patch.appendMessages!))
        return { action: "invalidate" };
      return {
        action: "apply",
        nextChat: buildChatObject(
          chat,
          patch,
          [...(chat.messages ?? []), ...patch.appendMessages!],
          incomingSequence!,
          currentMessageSeq ?? null,
          currentPatchVersion ?? null,
        ),
      };
    }
    return { action: "invalidate" };
  }

  // Dual-seq: message-carrying patch
  if (patch.appendMessages?.length && incomingMessageSeq !== undefined) {
    if (currentMessageSeq != null && incomingMessageSeq <= currentMessageSeq) {
      if (
        incomingPatchVersion !== undefined &&
        (currentPatchVersion == null ||
          incomingPatchVersion > currentPatchVersion)
      ) {
        return {
          action: "apply",
          nextChat: buildChatObject(
            chat,
            patch,
            chat.messages ?? [],
            patch.chatSequence ?? chat.chatSequence,
            currentMessageSeq,
            incomingPatchVersion,
          ),
        };
      }
      return { action: "ignore" };
    }
    if (currentMessageSeq != null && incomingMessageSeq > currentMessageSeq + 1)
      return { action: "invalidate" };
    if (!isDbMessageArray(patch.appendMessages))
      return { action: "invalidate" };
    return {
      action: "apply",
      nextChat: buildChatObject(
        chat,
        patch,
        [...(chat.messages ?? []), ...patch.appendMessages],
        patch.chatSequence ?? chat.chatSequence,
        incomingMessageSeq,
        incomingPatchVersion ?? currentPatchVersion ?? null,
      ),
    };
  }

  // Metadata-only patch
  if (incomingPatchVersion !== undefined) {
    if (
      currentPatchVersion != null &&
      incomingPatchVersion <= currentPatchVersion
    )
      return { action: "ignore" };
    return {
      action: "apply",
      nextChat: buildChatObject(
        chat,
        patch,
        chat.messages ?? [],
        patch.chatSequence ?? chat.chatSequence,
        incomingMessageSeq ?? currentMessageSeq ?? null,
        incomingPatchVersion,
      ),
    };
  }

  // Confirmation patch with messageSeq only
  if (incomingMessageSeq !== undefined) {
    return {
      action: "apply",
      nextChat: buildChatObject(
        chat,
        patch,
        chat.messages ?? [],
        patch.chatSequence ?? chat.chatSequence,
        incomingMessageSeq,
        currentPatchVersion ?? null,
      ),
    };
  }

  return { action: "invalidate" };
}

function buildChatObject(
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
    messages: nextMessages,
    messageCount: nextMessages.length,
    chatSequence,
    messageSeq: messageSeq ?? 0,
    patchVersion,
  };
}
