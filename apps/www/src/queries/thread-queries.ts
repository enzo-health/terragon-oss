import { getThreadAction } from "@/server-actions/get-thread";
import { getThreadsAction } from "@/server-actions/get-threads";
import { getThreadPageShellAction } from "@/server-actions/get-thread-page-shell";
import { getThreadPageChatAction } from "@/server-actions/get-thread-page-chat";
import { getThreadPageDiffAction } from "@/server-actions/get-thread-page-diff";
import { getServerActionQueryOptions } from "./server-action-helpers";
import type {
  ThreadInfo,
  ThreadPageChat,
  ThreadPageDiff,
  ThreadPageShell,
} from "@terragon/shared/db/types";
import {
  useInfiniteQuery,
  skipToken,
  type InfiniteData,
  type QueryKey,
  type SkipToken,
  type UseInfiniteQueryOptions,
} from "@tanstack/react-query";
import { unwrapResult } from "@/lib/server-actions";
import type { ThreadListFilters } from "@terragon/shared/model/thread-list-projection";

export {
  isValidThreadListFilter,
  matchesThreadListProjectionFilter as isMatchingThreadForFilter,
  parseThreadListProjectionFilter,
  type ThreadListFilters,
} from "@terragon/shared/model/thread-list-projection";

type ThreadListQueryKey =
  | readonly ["threads", "list"]
  | readonly ["threads", "list", ThreadListFilters];

export const threadQueryKeys = {
  list: (filters: ThreadListFilters | null): ThreadListQueryKey =>
    filters ? (["threads", "list", filters] as const) : ["threads", "list"],
  detail: (id: string) => ["threads", "detail", id] as const,
  shell: (id: string) => ["threads", "shell", id] as const,
  chat: (threadId: string, threadChatId: string) =>
    ["threads", "chat", threadId, threadChatId] as const,
  diff: (threadId: string) => ["threads", "diff", threadId] as const,
};

export function threadQueryOptions(threadId: string) {
  return getServerActionQueryOptions({
    queryKey: threadQueryKeys.detail(threadId),
    queryFn: async () => {
      return getThreadAction(threadId);
    },
  });
}

export function threadShellQueryOptions(threadId: string) {
  return getServerActionQueryOptions<ThreadPageShell>({
    queryKey: threadQueryKeys.shell(threadId),
    queryFn: async () => {
      return getThreadPageShellAction(threadId);
    },
  });
}

// Function overloads narrow the return type so callers that pass concrete
// params get the strongly-typed query options (queryFn: () => Promise<...>),
// while the skipToken overload gets the skip-shape. This matters because
// `queryClient.fetchQuery(...)` and `useQuery(...)` reject a `symbol` queryFn
// when it appears in a union — the unique-symbol overload only resolves on a
// pure skipToken, not a widened symbol.
export function threadChatQueryOptions(params: {
  threadId: string;
  threadChatId: string;
}): ReturnType<typeof getServerActionQueryOptions<ThreadPageChat>>;
export function threadChatQueryOptions(params: SkipToken): {
  queryKey: readonly ["threads", "chat", "__skip__"];
  queryFn: SkipToken;
};
export function threadChatQueryOptions(
  params: { threadId: string; threadChatId: string } | SkipToken,
) {
  // Pass `skipToken` (from @tanstack/react-query) when the threadChatId is
  // not yet known. React Query treats `queryFn: skipToken` as "do not run",
  // which is the typed replacement for the old `enabled: false` + sentinel
  // queryKey hack.
  if (params === skipToken) {
    return {
      queryKey: ["threads", "chat", "__skip__"] as const,
      queryFn: skipToken,
    };
  }
  const { threadId, threadChatId } = params;
  return getServerActionQueryOptions<ThreadPageChat>({
    queryKey: threadQueryKeys.chat(threadId, threadChatId),
    queryFn: async () => {
      return getThreadPageChatAction({ threadId, threadChatId });
    },
  });
}

export function threadDiffQueryOptions(threadId: string) {
  return getServerActionQueryOptions<ThreadPageDiff>({
    queryKey: threadQueryKeys.diff(threadId),
    queryFn: async () => {
      return getThreadPageDiffAction(threadId);
    },
  });
}

const THREADS_PER_PAGE = 100;

export function threadListQueryOptions(filters: ThreadListFilters = {}) {
  const { archived, automationId, limit = THREADS_PER_PAGE } = filters;
  const options: UseInfiniteQueryOptions<
    ThreadInfo[],
    unknown,
    InfiniteData<ThreadInfo[]>,
    ThreadInfo[],
    QueryKey,
    number
  > = {
    queryKey: threadQueryKeys.list(filters),
    queryFn: async ({ pageParam }) => {
      const offset = pageParam * limit;
      return unwrapResult(
        await getThreadsAction({ archived, automationId, limit, offset }),
      );
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => {
      return lastPage.length === limit ? pages.length : undefined;
    },
    // Real-time WebSocket patches keep list fresh, so use a longer staleTime
    // to avoid unnecessary refetches on mount/tab-switch
    staleTime: 2 * 60 * 1000,
  };
  return options;
}

export function useInfiniteThreadList(filters: ThreadListFilters = {}) {
  return useInfiniteQuery(threadListQueryOptions(filters));
}
