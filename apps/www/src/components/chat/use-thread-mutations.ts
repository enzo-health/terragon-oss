"use client";

import { useQueryClient } from "@tanstack/react-query";
import { AIAgent } from "@terragon/agent/types";
import { ThreadErrorMessage, ThreadInfoFull } from "@terragon/shared";
import { useCallback } from "react";
import { unwrapError } from "@/lib/server-actions";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import {
  threadChatQueryOptions,
  threadQueryKeys,
} from "@/queries/thread-queries";
import { retryGitCheckpoint } from "@/server-actions/retry-git-checkpoint";
import { retryThread } from "@/server-actions/retry-thread";
import { createThreadViewSnapshot } from "./thread-view-model/snapshot-adapter";
import type { ThreadViewModelController } from "./use-thread-view-model";

/**
 * Retry mutation: branches between `retryGitCheckpoint` and `retryThread`
 * based on the current chat error code, invalidates shell + chat queries on
 * success, and surfaces failures via `setError`. Pure React Query plumbing
 * — kept out of `chat-ui.tsx` for the LOC budget.
 */
export function useRetryThreadMutation({
  threadId,
  threadChatId,
  errorMessage,
  isReadOnly,
  setError,
}: {
  threadId: string;
  threadChatId: string;
  errorMessage: string | null | undefined;
  isReadOnly: boolean;
  setError: (error: ThreadErrorMessage | null) => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useServerActionMutation({
    mutationFn: async () => {
      if (
        errorMessage === "git-checkpoint-push-failed" ||
        errorMessage === "git-checkpoint-diff-failed"
      ) {
        return await retryGitCheckpoint({ threadId, threadChatId });
      }
      return await retryThread({ threadId, threadChatId });
    },
    onMutate: () => setError(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: threadQueryKeys.chat(threadId, threadChatId),
      });
      void queryClient.invalidateQueries({
        queryKey: threadQueryKeys.shell(threadId),
      });
    },
    onError: (error) => setError(unwrapError(error)),
  });

  const handleRetry = useCallback(async () => {
    if (isReadOnly) {
      // Surface the error via setError instead of throwing into the event
      // handler. Throwing from a button click handler unwinds into React's
      // synthetic event dispatch and the user sees a blank screen.
      setError("Cannot retry thread in read-only mode");
      return;
    }
    await mutation.mutateAsync();
  }, [isReadOnly, mutation, setError]);

  return { handleRetry, isRetrying: mutation.isPending };
}

/**
 * Returns a memoized callback that re-fetches the active thread chat from
 * the server and dispatches a `server.refetch-reconciled` event into the
 * view model. Used by the prompt box to settle optimistic state after
 * follow-up / queue / stop calls.
 *
 * Error handling: if the fetch fails (network error, server error, etc.),
 * the error is logged via `console.warn` and forwarded to the optional
 * `setError` callback. The returned promise still resolves so callers do
 * not need to wrap each invocation in try/catch — but they MAY also handle
 * the returned promise themselves if they want to react to the failure.
 */
export function useReconcileActiveChatFromServer({
  threadId,
  threadChatId,
  threadViewModel,
  chatAgent,
  thread,
  setError,
}: {
  threadId: string;
  threadChatId: string;
  threadViewModel: ThreadViewModelController;
  chatAgent: AIAgent;
  thread: Pick<ThreadInfoFull, "id" | "updatedAt" | "gitDiff" | "gitDiffStats">;
  setError?: (error: ThreadErrorMessage | null) => void;
}) {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    try {
      const reconciledChat = await queryClient.fetchQuery(
        threadChatQueryOptions({ threadId, threadChatId }),
      );
      threadViewModel.dispatchThreadViewEvent({
        type: "server.refetch-reconciled",
        snapshot: createThreadViewSnapshot({
          threadChat: reconciledChat,
          agent: chatAgent,
          source: "react-query",
          artifactThread: {
            id: thread.id,
            updatedAt: thread.updatedAt,
            gitDiff: thread.gitDiff,
            gitDiffStats: thread.gitDiffStats ?? null,
          },
          githubSummary: threadViewModel.githubSummary,
          meta: threadViewModel.meta,
          runId: threadViewModel.lifecycle.runId,
        }),
      });
    } catch (error) {
      console.warn(
        "[useReconcileActiveChatFromServer] failed to reconcile thread chat",
        { threadId, threadChatId, error },
      );
      setError?.(unwrapError(error));
    }
  }, [
    chatAgent,
    queryClient,
    setError,
    thread.gitDiff,
    thread.gitDiffStats,
    thread.id,
    thread.updatedAt,
    threadChatId,
    threadId,
    threadViewModel.dispatchThreadViewEvent,
    threadViewModel.githubSummary,
    threadViewModel.lifecycle.runId,
    threadViewModel.meta,
  ]);
}
