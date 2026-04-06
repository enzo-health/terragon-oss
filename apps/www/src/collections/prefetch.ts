"use client";

import { seedShell } from "./thread-shell-collection";
import { seedChat } from "./thread-chat-collection";
import { getThreadPageShellAction } from "@/server-actions/get-thread-page-shell";
import { getThreadPageChatAction } from "@/server-actions/get-thread-page-chat";
import { unwrapResult } from "@/lib/server-actions";
import { getOrCreateQueryClient } from "@/lib/query-client";
import { threadQueryKeys } from "@/queries/thread-queries";

const inflight = new Set<string>();

/**
 * Prefetch thread shell + chat on hover for instant switching.
 *
 * Writes to BOTH:
 * 1. TanStack DB collections (for WebSocket patch reactivity)
 * 2. React Query cache (so useQuery finds data immediately on mount — no loading state)
 *
 * This eliminates the sequential shell→chat dependency: both are pre-populated
 * in the React Query cache before the user clicks, so ChatUI renders instantly.
 */
export function prefetchThreadIntoCollections(threadId: string): void {
  const queryClient = getOrCreateQueryClient();

  // Skip if React Query already has fresh shell data (cache hit from prior visit)
  const existingShell = queryClient.getQueryData(
    threadQueryKeys.shell(threadId),
  );
  if (existingShell) return;

  if (inflight.has(threadId)) return;
  inflight.add(threadId);

  getThreadPageShellAction(threadId)
    .then((result) => {
      const shell = unwrapResult(result);

      // Write to React Query cache — useQuery(shell) will find this immediately
      queryClient.setQueryData(threadQueryKeys.shell(threadId), shell);

      // Write to TanStack DB collection (for WebSocket reactivity)
      seedShell(shell);

      if (shell.primaryThreadChatId) {
        return getThreadPageChatAction({
          threadId,
          threadChatId: shell.primaryThreadChatId,
        }).then((chatResult) => {
          const chat = unwrapResult(chatResult);

          // Write to React Query cache — useQuery(chat) will find this immediately
          queryClient.setQueryData(
            threadQueryKeys.chat(threadId, shell.primaryThreadChatId),
            chat,
          );

          // Write to TanStack DB collection
          seedChat(chat);
        });
      }
    })
    .catch((err) => console.warn("[prefetch] failed for thread", threadId, err))
    .finally(() => inflight.delete(threadId));
}
