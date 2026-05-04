"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ensureAgent } from "@terragon/agent/utils";
import {
  DBUserMessage,
  ThreadErrorMessage,
  ThreadInfoFull,
  ThreadStatus,
  UIMessage,
  UIUserMessage,
} from "@terragon/shared";
import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAgentWorking } from "@/agent/thread-status";
import { useAgUiTransport } from "@/hooks/use-ag-ui-transport";
import {
  type ScopedRunIdState,
  selectScopedRunId,
  useCurrentRunId,
} from "@/hooks/use-current-run-id";
import { usePlatform } from "@/hooks/use-platform";
import { useScrollToBottom } from "@/hooks/useScrollToBottom";
import { threadDiffQueryOptions } from "@/queries/thread-queries";
import { fetchAgUiHistoryMessages } from "@/lib/ag-ui-history-fetch";
import {
  getCachedTranscript,
  invalidateCachedTranscript,
  seedTranscript,
} from "@/collections/thread-transcript-collection";
import {
  ChatUILayout,
  type ChatUICoreData,
  type ChatUIDialogData,
  type ChatUIErrorState,
  type ChatUIOptimisticHandlers,
  type ChatUIPanelState,
  type ChatUIScrollState,
  type ChatUIViewModelData,
} from "./chat-ui-layout";
import {
  useMarkChatAsRead,
  useSecondaryPanel,
  useThreadDocumentTitleAndFavicon,
} from "./hooks";
import { LeafLoading } from "./leaf-loading";
import {
  createOptimisticPermissionModeUpdatedEvent,
  createOptimisticQueuedMessagesUpdatedEvent,
  createOptimisticUserSubmittedEvent,
} from "./thread-view-model/optimistic-events";
import { ThreadProvider, useThreadContext } from "./thread-provider";
import {
  useAutoOpenPanelOnNewPlan,
  useAutoOpenSecondaryPanelOnDiff,
  useInvalidateCreditBalanceOnAgentIdle,
} from "./use-chat-effects";
import { useChatViewSnapshot } from "./use-chat-view-snapshot";
import {
  useReconcileActiveChatFromServer,
  useRetryThreadMutation,
} from "./use-thread-mutations";
import { useThreadViewModel } from "./use-ag-ui-messages";

function submittedUserMessageToOptimisticUiMessage({
  message,
  index,
  threadChatId,
}: {
  message: DBUserMessage;
  index: number;
  threadChatId: string;
}): UIUserMessage {
  return {
    id: `user-optimistic-local-${threadChatId}-${index}-${message.timestamp ?? "pending"}`,
    role: "user",
    parts: message.parts,
    timestamp: message.timestamp,
    model: message.model,
  };
}

function isSameUiUserMessage(
  left: UIUserMessage,
  right: UIUserMessage,
): boolean {
  return (
    left.parts.length === right.parts.length &&
    left.parts.every(
      (part, index) =>
        JSON.stringify(part) === JSON.stringify(right.parts[index]),
    )
  );
}

function appendUniqueUiUserMessages(
  baseMessages: UIUserMessage[],
  nextMessages: UIUserMessage[],
): UIUserMessage[] {
  let didAppend = false;
  const out = [...baseMessages];
  for (const message of nextMessages) {
    if (out.some((existing) => isSameUiUserMessage(existing, message))) {
      continue;
    }
    out.push(message);
    didAppend = true;
  }
  return didAppend ? out : baseMessages;
}

function getOptimisticUserMessages({
  messages,
  submittedMessages,
}: {
  messages: UIMessage[];
  submittedMessages: UIUserMessage[];
}): UIUserMessage[] {
  const optimisticSubmittedMessages = messages.filter(
    (message): message is UIUserMessage =>
      message.role === "user" && message.id.startsWith("user-optimistic-"),
  );
  return appendUniqueUiUserMessages(
    optimisticSubmittedMessages,
    submittedMessages,
  );
}

// Wires AG-UI transport, view model, runtime mutations, and effects for an
// active thread. Bootstrap queries + loading gate live in <ThreadProvider/>;
// JSX layout in <ChatUILayout/>; reusable effects in use-chat-effects.ts.
function ChatUIContent() {
  const {
    threadId,
    threadChatId,
    isReadOnly,
    shell,
    threadChat,
    threadChatSource,
  } = useThreadContext();
  const queryClient = useQueryClient();

  const transcriptRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const promptBoxRef = useRef<{
    focus: () => void;
    setPermissionMode: (mode: "allowAll" | "plan") => void;
  } | null>(null);

  const { messagesEndRef, isAtBottom, forceScrollToBottom } = useScrollToBottom(
    { observedRef: transcriptRef },
  );
  const platform = usePlatform();
  const [error, setError] = useState<ThreadErrorMessage | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [submittedOptimisticUserState, setSubmittedOptimisticUserState] =
    useState<{ threadChatId: string; messages: UIUserMessage[] }>(() => ({
      threadChatId,
      messages: [],
    }));
  const submittedOptimisticUserMessages =
    submittedOptimisticUserState.threadChatId === threadChatId
      ? submittedOptimisticUserState.messages
      : [];
  // Defer scroll-to-bottom button visibility so the initial auto-scroll can fire first.
  const [hasInitialized, setHasInitialized] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setHasInitialized(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const {
    shouldAutoOpenSecondaryPanel,
    isSecondaryPanelOpen,
    setIsSecondaryPanelOpen,
  } = useSecondaryPanel();

  const hasLiveDiffSignal = Boolean(
    shell.hasGitDiff || (shell.gitDiffStats?.files ?? 0) > 0,
  );
  const shouldLoadDiff = Boolean(
    isSecondaryPanelOpen ||
      (platform === "desktop" &&
        shouldAutoOpenSecondaryPanel &&
        hasLiveDiffSignal),
  );
  const shouldRenderSecondaryPanel =
    isSecondaryPanelOpen ||
    (platform === "desktop" &&
      shouldAutoOpenSecondaryPanel &&
      hasLiveDiffSignal);
  const { data: threadDiff } = useQuery({
    ...threadDiffQueryOptions(threadId),
    enabled: shouldLoadDiff,
  });

  const chatAgent = ensureAgent(threadChat.agent);
  const [capturedRun, setCapturedRun] = useState<ScopedRunIdState | null>(null);
  const capturedRunId = selectScopedRunId({
    state: capturedRun,
    threadId,
    threadChatId: threadChat.id,
  });

  const {
    thread,
    threadViewSnapshot,
    lastUsedModel,
    redoDialogData,
    forkDialogData,
  } = useChatViewSnapshot({
    shell,
    threadChat,
    threadDiff: threadDiff ?? null,
    threadChatSource,
    agent: chatAgent,
    capturedRunId,
    threadId,
  });

  useAutoOpenSecondaryPanelOnDiff({
    hasLiveDiffSignal,
    shouldAutoOpenSecondaryPanel,
    isSecondaryPanelOpen,
    setIsSecondaryPanelOpen,
  });
  useThreadDocumentTitleAndFavicon({
    name: shell.name ?? "",
    isThreadUnread: !!shell.isUnread,
    isReadOnly,
  });
  useMarkChatAsRead({
    threadId,
    threadChatId,
    threadIsUnread: !!shell.isUnread,
    isReadOnly,
  });

  const loadAgUiHistoryMessages = useCallback(async () => {
    // Stale-while-revalidate against the transcript collection.
    //
    // 1. If we have a cached snapshot (warmed by sidebar prefetch or a prior
    //    visit), return it synchronously so the runtime hydrates instantly
    //    with no "Loading task history..." placeholder.
    //
    // 2. Always kick off a background revalidation that updates the collection
    //    so the next open is fresh. For active runs the runtime applies
    //    `fromSeq=cachedLastSeq` and the SSE replay fills in any gap.
    const cached = getCachedTranscript(threadId, threadChatId);
    if (cached) {
      const controller = new AbortController();
      void fetchAgUiHistoryMessages({
        threadId,
        threadChatId,
        signal: controller.signal,
      })
        .then((fresh) =>
          seedTranscript({ threadId, threadChatId, result: fresh }),
        )
        .catch((err) => {
          // Background revalidation failure is non-fatal — the runtime is
          // already hydrated. Drop the cached entry so the next visit refetches
          // (avoids serving an entry that may be permanently broken).
          if (!controller.signal.aborted) {
            console.warn("[transcript-cache] revalidation failed", err);
            invalidateCachedTranscript(threadId, threadChatId);
          }
        });
      return cached;
    }

    const fresh = await fetchAgUiHistoryMessages({ threadId, threadChatId });
    seedTranscript({ threadId, threadChatId, result: fresh });
    return fresh;
  }, [threadChatId, threadId]);
  const agent = useAgUiTransport({
    threadId,
    threadChatId,
    runId: capturedRunId,
  });
  const observedRunId = useCurrentRunId(agent);
  useEffect(() => {
    // Pin the captured runId to the latest RUN_STARTED on the current
    // HttpAgent. Reset on agent identity change (thread switch) so a stale
    // runId from a previous chat never leaks into a new reconnect URL.
    setCapturedRun({
      threadId,
      threadChatId: threadChat.id,
      runId: observedRunId,
    });
  }, [observedRunId, threadChat.id, threadId]);

  const threadViewModel = useThreadViewModel({
    agent,
    snapshot: threadViewSnapshot,
  });
  const runtimeMessagesRef = useRef<UIMessage[]>([]);
  const queuedMessages = threadViewModel.queuedMessages;
  const artifactDescriptors = threadViewModel.artifacts.descriptors;

  const dispatch = threadViewModel.dispatchThreadViewEvent;
  const onOptimisticPermissionModeUpdate = useCallback(
    (mode: "allowAll" | "plan") =>
      dispatch(createOptimisticPermissionModeUpdatedEvent(mode)),
    [dispatch],
  );

  const toolProps = useMemo(
    () => ({
      threadId,
      threadChatId: threadViewModel.threadChatId,
      messagesRef: runtimeMessagesRef,
      isReadOnly,
      promptBoxRef,
      childThreads: shell.childThreads ?? [],
      githubRepoFullName: thread.githubRepoFullName ?? "",
      repoBaseBranchName: thread.repoBaseBranchName ?? "main",
      branchName: thread.branchName ?? null,
      onOptimisticPermissionModeUpdate,
    }),
    [
      isReadOnly,
      onOptimisticPermissionModeUpdate,
      shell.childThreads,
      thread.branchName,
      thread.githubRepoFullName,
      thread.repoBaseBranchName,
      threadViewModel.threadChatId,
      threadId,
    ],
  );

  const reconcileActiveChatFromServer = useReconcileActiveChatFromServer({
    threadId,
    threadChatId,
    threadViewModel,
    chatAgent,
    thread,
    setError,
  });

  const handleOpenArtifact = useCallback(
    (artifactId: string) => {
      setActiveArtifactId(artifactId);
      setIsSecondaryPanelOpen(true);
    },
    [setIsSecondaryPanelOpen],
  );

  useAutoOpenPanelOnNewPlan({
    artifactDescriptors,
    shouldAutoOpenSecondaryPanel,
    threadId,
    onOpenArtifact: handleOpenArtifact,
  });

  const effectiveThreadStatus = threadViewModel.lifecycle.threadStatus;
  const isAgentCurrentlyWorking =
    effectiveThreadStatus !== null && isAgentWorking(effectiveThreadStatus);
  useInvalidateCreditBalanceOnAgentIdle({
    isAgentCurrentlyWorking,
    queryClient,
  });

  const scrollToTop = useCallback(() => {
    if (scrollAreaRef.current) {
      const scrollViewport = scrollAreaRef.current.querySelector(
        '[data-slot="scroll-area-viewport"]',
      );
      if (scrollViewport) {
        scrollViewport.scrollTop = 0;
      }
    }
  }, []);
  const { handleRetry, isRetrying } = useRetryThreadMutation({
    threadId,
    threadChatId,
    errorMessage: threadChat.errorMessage,
    isReadOnly,
    setError,
  });

  const threadWithViewModelStatus = useMemo<ThreadInfoFull>(() => {
    const viewModelThreadStatus = threadViewModel.threadStatus;
    if (!viewModelThreadStatus || thread.threadChats.length === 0) {
      return thread;
    }
    return {
      ...thread,
      threadChats: thread.threadChats.map((chat) =>
        chat.id === threadChat.id
          ? { ...chat, status: viewModelThreadStatus }
          : chat,
      ),
    };
  }, [thread, threadChat.id, threadViewModel.threadStatus]);

  const onOptimisticUserSubmit = useCallback(
    (userMessage: DBUserMessage, optimisticStatus: ThreadStatus) => {
      setSubmittedOptimisticUserState((current) => {
        const currentMessages =
          current.threadChatId === threadChatId ? current.messages : [];
        return {
          threadChatId,
          messages: appendUniqueUiUserMessages(currentMessages, [
            submittedUserMessageToOptimisticUiMessage({
              message: userMessage,
              index: currentMessages.length,
              threadChatId,
            }),
          ]),
        };
      });
      dispatch(
        createOptimisticUserSubmittedEvent({
          message: userMessage,
          optimisticStatus,
        }),
      );
    },
    [dispatch, threadChatId],
  );

  const onOptimisticQueuedMessagesUpdate = useCallback(
    (messages: DBUserMessage[]) =>
      dispatch(createOptimisticQueuedMessagesUpdatedEvent(messages)),
    [dispatch],
  );

  // Group props by concern so `<ChatUILayout/>` sees a stable ~7-prop signature
  // instead of 49 individual fields. Each group is `useMemo`-wrapped so its
  // identity is stable across re-renders that don't touch the underlying data.
  // The `agent` early-null guard below is intentionally placed AFTER the hooks
  // (the conditional `null` flows through the memo dependency arrays via the
  // typed-narrowing assertion at the render site).
  const coreData = useMemo<ChatUICoreData | null>(
    () =>
      agent
        ? {
            agent,
            chatAgent,
            isReadOnly,
            threadId,
            threadChatId,
            threadChat,
            thread,
            threadWithViewModelStatus,
          }
        : null,
    [
      agent,
      chatAgent,
      isReadOnly,
      thread,
      threadChat,
      threadChatId,
      threadId,
      threadWithViewModelStatus,
    ],
  );

  const viewModel = useMemo<ChatUIViewModelData>(
    () => ({
      threadViewModel,
      loadAgUiHistoryMessages,
      queuedMessages,
      optimisticUserMessages: getOptimisticUserMessages({
        messages: threadViewModel.messages,
        submittedMessages: submittedOptimisticUserMessages,
      }),
      artifactDescriptors,
      effectiveThreadStatus,
      isAgentCurrentlyWorking,
      toolProps,
      lastUsedModel,
      handleOpenArtifact,
    }),
    [
      artifactDescriptors,
      effectiveThreadStatus,
      handleOpenArtifact,
      isAgentCurrentlyWorking,
      lastUsedModel,
      loadAgUiHistoryMessages,
      queuedMessages,
      submittedOptimisticUserMessages,
      threadViewModel,
      toolProps,
    ],
  );

  const scrollState = useMemo<ChatUIScrollState>(
    () => ({
      transcriptRef,
      scrollAreaRef,
      chatContainerRef,
      messagesEndRef,
      promptBoxRef,
      forceScrollToBottom,
      scrollToTop,
      isAtBottom,
      hasInitialized,
    }),
    [
      forceScrollToBottom,
      hasInitialized,
      isAtBottom,
      messagesEndRef,
      scrollToTop,
    ],
  );

  const panelState = useMemo<ChatUIPanelState>(
    () => ({
      activeArtifactId,
      setActiveArtifactId,
      showTerminal,
      setShowTerminal,
      shouldRenderSecondaryPanel,
      platform,
    }),
    [activeArtifactId, platform, shouldRenderSecondaryPanel, showTerminal],
  );

  const dialogData = useMemo<ChatUIDialogData>(
    () => ({ redoDialogData, forkDialogData }),
    [forkDialogData, redoDialogData],
  );

  const optimisticHandlers = useMemo<ChatUIOptimisticHandlers>(
    () => ({
      onOptimisticUserSubmit,
      onOptimisticQueuedMessagesUpdate,
      onOptimisticPermissionModeUpdate,
      reconcileActiveChatFromServer,
    }),
    [
      onOptimisticPermissionModeUpdate,
      onOptimisticQueuedMessagesUpdate,
      onOptimisticUserSubmit,
      reconcileActiveChatFromServer,
    ],
  );

  const errorState = useMemo<ChatUIErrorState>(
    () => ({ error, setError, isRetrying, handleRetry }),
    [error, handleRetry, isRetrying],
  );

  if (!coreData) {
    // `useAgUiTransport` returns null only when `threadChatId` is falsy,
    // which the provider has already gated against. Keep this guard so
    // TypeScript narrows downstream and we never render against a null
    // agent.
    return (
      <div className="flex flex-col h-full w-full items-center justify-center">
        <LeafLoading message="Loading task…" />
      </div>
    );
  }

  return (
    <ChatUILayout
      coreData={coreData}
      viewModel={viewModel}
      scrollState={scrollState}
      panelState={panelState}
      dialogData={dialogData}
      optimisticHandlers={optimisticHandlers}
      errorState={errorState}
    />
  );
}

function ChatUI({
  threadId,
  isReadOnly,
}: {
  threadId: string;
  isReadOnly: boolean;
}) {
  return (
    <ThreadProvider threadId={threadId} isReadOnly={isReadOnly}>
      <ChatUIContent />
    </ThreadProvider>
  );
}

const ChatUIMemo = memo(ChatUI);

// Client-only: useLiveQuery requires useSyncExternalStore (no getServerSnapshot).
// page.tsx still prefetches into React Query for first-visit hydration.
export default dynamic(() => Promise.resolve(ChatUIMemo), { ssr: false });
