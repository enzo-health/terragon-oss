"use client";

import { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import {
  DBUserMessage,
  ThreadInfo,
  ThreadSourceMetadata,
} from "@terragon/shared";
import { BroadcastThreadPatch } from "@terragon/types/broadcast";
import {
  isMatchingThreadForFilter,
  isValidThreadListFilter,
  threadQueryKeys,
} from "./thread-queries";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
): { didFindThreadInAnyQuery: boolean } {
  const listQueries = queryClient
    .getQueryCache()
    .findAll({ queryKey: threadQueryKeys.list(null) });
  const cachedBaseThread = findThreadInListQueries(queryClient, patch.threadId);
  const shellBaseThread = patch.shell
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

function invalidateThreadPatchRefetchTargets(
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
