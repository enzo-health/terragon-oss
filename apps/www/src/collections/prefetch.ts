"use client";

import { seedShell } from "./thread-shell-collection";
import { seedChat } from "./thread-chat-collection";
import { seedTranscript } from "./thread-transcript-collection";
import { getThreadPageShellAction } from "@/server-actions/get-thread-page-shell";
import { getThreadPageChatAction } from "@/server-actions/get-thread-page-chat";
import { unwrapResult } from "@/lib/server-actions";
import { getOrCreateQueryClient } from "@/lib/query-client";
import { threadQueryKeys } from "@/queries/thread-queries";
import { fetchAgUiHistoryMessages } from "@/lib/ag-ui-history-fetch";
import type { ThreadPageShell } from "@terragon/shared/db/types";

const inflight = new Set<string>();
const transcriptInflight = new Set<string>();

/**
 * Idle-callback wrapper. Defers prefetch work until the browser is idle so we
 * don't compete with the user's hover/scroll interactions.
 */
function runWhenIdle(cb: () => void): void {
  if (typeof window === "undefined") return;
  const ric = (
    window as unknown as {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout: number },
      ) => number;
    }
  ).requestIdleCallback;
  if (typeof ric === "function") {
    ric(cb, { timeout: 1500 });
    return;
  }
  setTimeout(cb, 200);
}

/**
 * Background-fetch the AG-UI transcript for a (threadId, threadChatId) and
 * write it into the transcript collection. Dedupes concurrent calls and
 * swallows errors (chat-ui will refetch as the source of truth on click).
 */
export function prefetchThreadTranscript({
  threadId,
  threadChatId,
}: {
  threadId: string;
  threadChatId: string;
}): void {
  const key = `${threadId}:${threadChatId}`;
  if (transcriptInflight.has(key)) return;
  transcriptInflight.add(key);
  runWhenIdle(() => {
    fetchAgUiHistoryMessages({ threadId, threadChatId })
      .then((result) => {
        seedTranscript({ threadId, threadChatId, result });
      })
      .catch((err) =>
        console.warn("[prefetch] transcript failed", threadId, err),
      )
      .finally(() => {
        transcriptInflight.delete(key);
      });
  });
}

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
  if (existingShell) {
    // Shell is warm but the transcript may not be cached yet (e.g., user
    // visited this thread before the transcript collection existed, or the
    // prior cache entry was evicted). Kick off transcript prefetch so the
    // next click skips the loading placeholder.
    const shell = existingShell as ThreadPageShell;
    if (shell.primaryThreadChatId) {
      prefetchThreadTranscript({
        threadId,
        threadChatId: shell.primaryThreadChatId,
      });
    }
    return;
  }

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
        const primaryThreadChatId = shell.primaryThreadChatId;
        return getThreadPageChatAction({
          threadId,
          threadChatId: primaryThreadChatId,
        }).then((chatResult) => {
          const chat = unwrapResult(chatResult);

          // Write to React Query cache — useQuery(chat) will find this immediately
          queryClient.setQueryData(
            threadQueryKeys.chat(threadId, primaryThreadChatId),
            chat,
          );

          // Write to TanStack DB collection
          seedChat(chat);

          // Warm the AG-UI transcript cache so opening the chat skips the
          // "Loading task history..." placeholder.
          prefetchThreadTranscript({
            threadId,
            threadChatId: primaryThreadChatId,
          });
        });
      }
    })
    .catch((err) => console.warn("[prefetch] failed for thread", threadId, err))
    .finally(() => inflight.delete(threadId));
}
