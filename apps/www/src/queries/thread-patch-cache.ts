"use client";

import {
  QueryClient,
  type InfiniteData,
  type QueryKey,
} from "@tanstack/react-query";
import type { ThreadInfo } from "@terragon/shared";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import {
  applyThreadListProjectionPatch,
  buildThreadListProjectionFromPatch,
  compareThreadListProjection,
} from "@terragon/shared/model/thread-list-projection";
import {
  isMatchingThreadForFilter,
  isValidThreadListFilter,
  threadQueryKeys,
} from "./thread-queries";

export const threadPatchToListThread = (
  patch: BroadcastThreadPatch,
  fallbackThread?: ThreadInfo,
): ThreadInfo | undefined =>
  buildThreadListProjectionFromPatch({ patch, fallbackThread });

export const applyThreadPatchToListThread = applyThreadListProjectionPatch;

function sortThreadListPages(pages: ThreadInfo[][]): ThreadInfo[][] {
  const pageSizes = pages.map((page) => page.length);
  const sortedThreads = pages.flat().toSorted(compareThreadListProjection);
  let offset = 0;
  return pageSizes.map((size) => {
    const page = sortedThreads.slice(offset, offset + size);
    offset += size;
    return page;
  });
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
          return didChangeQuery
            ? { ...oldData, pages: sortThreadListPages(pages) }
            : oldData;
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
            const nextPages = [
              [nextThread, ...(firstPage ?? [])],
              ...restPages,
            ];
            return {
              ...oldData,
              pages: sortThreadListPages(nextPages),
            };
          }
        }

        return didChangeQuery
          ? { ...oldData, pages: sortThreadListPages(pages) }
          : oldData;
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
