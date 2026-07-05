"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import type {
  ThreadPageChat,
  ThreadPageShell,
} from "@terragon/shared/db/types";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from "react";
import {
  seedChat,
  useChatFromCollection,
} from "@/collections/thread-chat-collection";
import {
  seedShell,
  useShellFromCollection,
} from "@/collections/thread-shell-collection";
import {
  threadChatQueryOptions,
  threadShellQueryOptions,
} from "@/queries/thread-queries";
import { ChatError } from "./conversation/chrome/chat-error";
import { LeafLoading } from "./conversation/chrome/leaf-loading";
import { useThreadPageRealtimeSync } from "./use-thread-page-realtime-sync";

/**
 * Resolved thread bootstrap data exposed to children of {@link ThreadProvider}.
 *
 * The provider gates rendering: children only mount once shell + threadChat
 * are loaded AND `threadChat.id === shell.primaryThreadChatId`. Consumers can
 * therefore treat every field as guaranteed non-null. This invariant is
 * load-bearing — downstream chat state assumes it never observes a partial
 * shell/chat pair on first mount.
 */
export type ThreadContextValue = {
  threadId: string;
  threadChatId: string;
  isReadOnly: boolean;
  shell: ThreadPageShell;
  threadChat: ThreadPageChat;
  /** Tracks whether the chat row came from the live collection or the
   * background React Query fetch — used by the view-model snapshot to decide
   * which path is authoritative on the first paint. */
  threadChatSource: "collection" | "react-query";
};

const ThreadContext = createContext<ThreadContextValue | null>(null);

export function createProvisionalThreadPageChat(
  shell: ThreadPageShell,
): ThreadPageChat {
  return {
    id: shell.primaryThreadChat.id,
    userId: shell.userId,
    threadId: shell.id,
    title: null,
    createdAt: shell.createdAt,
    updatedAt: shell.primaryThreadChat.updatedAt,
    agent: shell.primaryThreadChat.agent,
    agentVersion: shell.primaryThreadChat.agentVersion,
    status: shell.primaryThreadChat.status,
    projectedMessages: [],
    queuedMessages: null,
    sessionId: null,
    errorMessage: shell.primaryThreadChat.errorMessage,
    errorMessageInfo: shell.primaryThreadChat.errorMessageInfo,
    scheduleAt: shell.primaryThreadChat.scheduleAt,
    reattemptQueueAt: shell.primaryThreadChat.reattemptQueueAt,
    contextLength: shell.primaryThreadChat.contextLength,
    permissionMode: shell.primaryThreadChat.permissionMode,
    codexPreviousResponseId: null,
    messageSeq: shell.primaryThreadChat.messageSeq,
    isUnread: shell.primaryThreadChat.isUnread,
    messageCount: 0,
    chatSequence: null,
    patchVersion: null,
    isCanonicalProjection: false,
  };
}

export function useThreadContext(): ThreadContextValue {
  const ctx = useContext(ThreadContext);
  if (!ctx) {
    throw new Error("useThreadContext must be used within <ThreadProvider/>");
  }
  return ctx;
}

/**
 * Owns React Query bootstrap for a thread page: shell + primary thread-chat
 * queries, collection seeding, and the loading gate. Renders a `LeafLoading`
 * skeleton until both feeds settle and agree on `primaryThreadChatId`, then
 * mounts `children` with a stable React `key` so the consumer's lazy
 * initializers see a fully hydrated context on first render.
 *
 * Loading/error decision: the provider RENDERS its own loading skeleton and
 * only mounts children when data is ready. Children never observe a
 * partially-hydrated context. This trades a tiny bit of flexibility for a
 * much simpler invariant for downstream reducers/effects.
 */
export function ThreadProvider({
  threadId,
  isReadOnly,
  children,
}: {
  threadId: string;
  isReadOnly: boolean;
  children: React.ReactNode;
}) {
  // TanStack DB collection is the primary read path (reactive to WebSocket
  // patches). React Query fetches in the background and seeds collections on
  // delivery. Hover-prefetch (prefetch.ts) pre-populates before mount for
  // instant switching.
  const {
    data: shellFromQuery,
    isLoading: isShellFetching,
    isError: isShellError,
    error: shellError,
    refetch: refetchShell,
  } = useQuery({
    ...threadShellQueryOptions(threadId),
  });
  useEffect(() => {
    if (shellFromQuery) seedShell(shellFromQuery);
  }, [shellFromQuery]);

  const shellFromCollection = useShellFromCollection(threadId);
  const shell = shellFromCollection ?? shellFromQuery ?? null;
  const isShellLoading = !shell && isShellFetching;

  const threadChatId = shell?.primaryThreadChatId;
  const {
    data: chatFromQuery,
    isError: isChatError,
    error: chatError,
    refetch: refetchChat,
  } = useQuery(
    threadChatId
      ? threadChatQueryOptions({ threadId, threadChatId })
      : threadChatQueryOptions(skipToken),
  );
  useEffect(() => {
    if (chatFromQuery) seedChat(chatFromQuery);
  }, [chatFromQuery]);

  const chatFromCollection = useChatFromCollection(threadId, threadChatId);
  const provisionalThreadChat = useMemo(
    () => (shell ? createProvisionalThreadPageChat(shell) : null),
    [shell],
  );
  const threadChat =
    chatFromCollection ?? chatFromQuery ?? provisionalThreadChat ?? null;
  const threadChatSource = chatFromCollection ? "collection" : "react-query";
  const contextValue = useMemo<ThreadContextValue | null>(() => {
    if (
      !shell ||
      !threadChat ||
      !threadChatId ||
      threadChat.id !== threadChatId
    ) {
      return null;
    }

    return {
      threadId,
      threadChatId,
      isReadOnly,
      shell,
      threadChat,
      threadChatSource,
    };
  }, [threadId, threadChatId, isReadOnly, shell, threadChat, threadChatSource]);

  useThreadPageRealtimeSync({ threadId });

  // Retry both queries when the user clicks the retry button. We swallow the
  // refetch error because <ChatError/> already surfaces it via `errorInfo`.
  const handleRetry = useCallback(async () => {
    await Promise.allSettled([refetchShell(), refetchChat()]);
  }, [refetchShell, refetchChat]);

  // If either query errored AND we don't yet have data from the live
  // collection to fall back on, render <ChatError/> instead of an infinite
  // spinner. The fallback short-circuits before the loading gate so a stale
  // collection seed can still keep the UI alive on transient network blips.
  if ((isShellError && !shell) || (isChatError && !threadChat)) {
    const err = isShellError ? shellError : chatError;
    const errorInfo = err instanceof Error ? err.message : String(err ?? "");
    return (
      <div className="flex flex-col h-full w-full items-center justify-center p-4">
        <div className="w-full max-w-2xl">
          <ChatError
            status="working-error"
            errorType="unknown-error"
            errorInfo={errorInfo}
            handleRetry={handleRetry}
            isReadOnly={isReadOnly}
          />
        </div>
      </div>
    );
  }

  if (
    isShellLoading ||
    !shell ||
    !threadChat ||
    !threadChatId ||
    threadChat.id !== threadChatId
  ) {
    return (
      <div className="flex flex-col h-full w-full items-center justify-center">
        <LeafLoading message="Loading task…" />
      </div>
    );
  }

  // The keyed Fragment preserves the previous `<ChatUIContent key={...}/>`
  // semantics: when (threadId, threadChatId) changes, React unmounts the
  // children so their lazy state initializers re-run with the fresh seed.
  return (
    <ThreadContext.Provider value={contextValue}>
      <React.Fragment key={`${threadId}:${threadChatId}`}>
        {children}
      </React.Fragment>
    </ThreadContext.Provider>
  );
}
