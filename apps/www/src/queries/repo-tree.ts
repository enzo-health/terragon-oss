import { getRepoTreeAction } from "@/server-actions/get-repo-tree";
import {
  getServerActionQueryOptions,
  useServerActionQuery,
} from "./server-action-helpers";

// The tree is keyed by thread; the ref is resolved server-side from thread
// state. Cached for the session — a push that moves the branch is picked up
// after staleTime, and the panel refetches on remount.
const REPO_TREE_STALE_TIME_MS = 5 * 60 * 1000;

export function repoTreeQueryKey(threadId: string) {
  return ["repo-tree", threadId] as const;
}

/** Query options usable for both `useQuery` and `queryClient.prefetchQuery`
 * (the panel-header hover prefetch). */
export function repoTreeQueryOptions(threadId: string) {
  return getServerActionQueryOptions({
    queryKey: repoTreeQueryKey(threadId),
    queryFn: () => getRepoTreeAction({ threadId }),
    staleTime: REPO_TREE_STALE_TIME_MS,
  });
}

export function useRepoTreeQuery(threadId: string | undefined) {
  return useServerActionQuery({
    queryKey: repoTreeQueryKey(threadId ?? ""),
    queryFn: () => getRepoTreeAction({ threadId: threadId ?? "" }),
    enabled: Boolean(threadId),
    staleTime: REPO_TREE_STALE_TIME_MS,
  });
}
