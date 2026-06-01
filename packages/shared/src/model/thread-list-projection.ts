import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import type { DBUserMessage } from "../db/db-message";
import type { ThreadInfo, ThreadSourceMetadata } from "../db/types";

export type ThreadListFilters = {
  archived?: boolean;
  automationId?: string;
  limit?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseThreadListProjectionFilter(
  value: unknown,
): ThreadListFilters | null {
  if (value === null || value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return null;
  }

  const archived = value.archived;
  if (archived !== undefined && typeof archived !== "boolean") {
    return null;
  }

  const automationId = value.automationId;
  if (automationId !== undefined && typeof automationId !== "string") {
    return null;
  }

  const limit = value.limit;
  if (
    limit !== undefined &&
    (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)
  ) {
    return null;
  }

  return {
    ...(archived !== undefined ? { archived } : {}),
    ...(automationId !== undefined ? { automationId } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

export function isValidThreadListFilter(
  value: unknown,
): value is ThreadListFilters {
  return parseThreadListProjectionFilter(value) !== null;
}

export function matchesThreadListProjectionFilter(
  thread: Pick<ThreadInfo, "archived" | "automationId">,
  filters: ThreadListFilters,
): boolean {
  if (filters.archived !== undefined && filters.archived !== thread.archived) {
    return false;
  }
  if (
    filters.automationId !== undefined &&
    filters.automationId !== thread.automationId
  ) {
    return false;
  }
  return true;
}

export function compareThreadListProjection(
  left: Pick<ThreadInfo, "id" | "updatedAt">,
  right: Pick<ThreadInfo, "id" | "updatedAt">,
): number {
  const updatedAtDelta = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (updatedAtDelta !== 0) {
    return updatedAtDelta;
  }
  return right.id.localeCompare(left.id);
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

function dateFromIso(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

export function getThreadListEffectiveUpdatedAt(
  candidates: readonly (Date | undefined)[],
  fallback: Date,
): Date {
  let latest = fallback;
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.getTime() > latest.getTime()) {
      latest = candidate;
    }
  }
  return latest;
}

export function buildThreadListProjectionFromPatch({
  patch,
  fallbackThread,
  now = new Date(),
}: {
  patch: BroadcastThreadPatch;
  fallbackThread?: ThreadInfo;
  now?: Date;
}): ThreadInfo | undefined {
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
  const updatedAt = getThreadListEffectiveUpdatedAt(
    [dateFromIso(shell.updatedAt), dateFromIso(patch.chat?.updatedAt)],
    fallbackThread?.updatedAt ?? now,
  );

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
      : (fallbackThread?.createdAt ?? now),
    updatedAt,
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

export function applyThreadListProjectionPatch(
  thread: ThreadInfo,
  patch: BroadcastThreadPatch,
): ThreadInfo {
  let threadChats = thread.threadChats;
  const chatUpdatedAt = dateFromIso(patch.chat?.updatedAt);
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

  const shellUpdatedAt = dateFromIso(patch.shell.updatedAt);
  const nextUpdatedAt = getThreadListEffectiveUpdatedAt(
    [shellUpdatedAt, chatUpdatedAt],
    thread.updatedAt,
  );
  const shouldUpdateTimestamp =
    nextUpdatedAt.getTime() > thread.updatedAt.getTime();

  return {
    ...thread,
    ...(patch.shell.userId !== undefined ? { userId: patch.shell.userId } : {}),
    ...(patch.shell.name !== undefined ? { name: patch.shell.name } : {}),
    ...(patch.shell.automationId !== undefined
      ? { automationId: patch.shell.automationId }
      : {}),
    ...(patch.shell.archived !== undefined
      ? { archived: patch.shell.archived }
      : {}),
    ...(patch.shell.visibility !== undefined
      ? { visibility: patch.shell.visibility }
      : {}),
    ...(patch.shell.isUnread !== undefined
      ? { isUnread: patch.shell.isUnread }
      : {}),
    ...(patch.shell.createdAt !== undefined
      ? { createdAt: new Date(patch.shell.createdAt) }
      : {}),
    ...(shouldUpdateTimestamp ? { updatedAt: nextUpdatedAt } : {}),
    ...(patch.shell.branchName !== undefined
      ? { branchName: patch.shell.branchName }
      : {}),
    ...(patch.shell.repoBaseBranchName !== undefined
      ? { repoBaseBranchName: patch.shell.repoBaseBranchName }
      : {}),
    ...(patch.shell.githubRepoFullName !== undefined
      ? { githubRepoFullName: patch.shell.githubRepoFullName }
      : {}),
    ...(patch.shell.githubPRNumber !== undefined
      ? { githubPRNumber: patch.shell.githubPRNumber }
      : {}),
    ...(patch.shell.githubIssueNumber !== undefined
      ? { githubIssueNumber: patch.shell.githubIssueNumber }
      : {}),
    ...(patch.shell.prStatus !== undefined
      ? { prStatus: patch.shell.prStatus }
      : {}),
    ...(patch.shell.prChecksStatus !== undefined
      ? { prChecksStatus: patch.shell.prChecksStatus }
      : {}),
    ...(patch.shell.sandboxStatus !== undefined
      ? { sandboxStatus: patch.shell.sandboxStatus }
      : {}),
    ...(patch.shell.bootingSubstatus !== undefined
      ? { bootingSubstatus: patch.shell.bootingSubstatus }
      : {}),
    ...(patch.shell.codesandboxId !== undefined
      ? { codesandboxId: patch.shell.codesandboxId }
      : {}),
    ...(patch.shell.sandboxProvider != null
      ? { sandboxProvider: patch.shell.sandboxProvider }
      : {}),
    ...(patch.shell.sandboxSize != null
      ? { sandboxSize: patch.shell.sandboxSize }
      : {}),
    ...(patch.shell.gitDiffStats !== undefined
      ? { gitDiffStats: patch.shell.gitDiffStats }
      : {}),
    ...(patch.shell.parentThreadId !== undefined
      ? { parentThreadId: patch.shell.parentThreadId }
      : {}),
    ...(patch.shell.parentToolId !== undefined
      ? { parentToolId: patch.shell.parentToolId }
      : {}),
    ...(patch.shell.draftMessage !== undefined &&
    (patch.shell.draftMessage === null ||
      isDbUserMessage(patch.shell.draftMessage))
      ? { draftMessage: patch.shell.draftMessage }
      : {}),
    ...(patch.shell.skipSetup != null
      ? { skipSetup: patch.shell.skipSetup }
      : {}),
    ...(patch.shell.disableGitCheckpointing != null
      ? {
          disableGitCheckpointing: patch.shell.disableGitCheckpointing,
        }
      : {}),
    ...(patch.shell.sourceType !== undefined
      ? { sourceType: patch.shell.sourceType }
      : {}),
    ...(patch.shell.sourceMetadata !== undefined &&
    isThreadSourceMetadata(patch.shell.sourceMetadata)
      ? { sourceMetadata: patch.shell.sourceMetadata }
      : {}),
    ...(patch.shell.version !== undefined
      ? { version: patch.shell.version }
      : {}),
    ...(patch.shell.authorName !== undefined
      ? { authorName: patch.shell.authorName }
      : {}),
    ...(patch.shell.authorImage !== undefined
      ? { authorImage: patch.shell.authorImage }
      : {}),
    sandboxProvider: patch.shell.sandboxProvider ?? thread.sandboxProvider,
    threadChats,
  };
}

export function shouldReplaceThreadListProjectionSeed(
  existing: ThreadInfo,
  incoming: ThreadInfo,
): boolean {
  const updatedAtDelta =
    incoming.updatedAt.getTime() - existing.updatedAt.getTime();
  if (updatedAtDelta !== 0) {
    return updatedAtDelta > 0;
  }
  if (incoming.messageSeq !== existing.messageSeq) {
    return incoming.messageSeq > existing.messageSeq;
  }
  return incoming.version >= existing.version;
}
