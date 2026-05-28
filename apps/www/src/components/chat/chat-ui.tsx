"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Message as AgUiMessage } from "@ag-ui/core";
import { ensureAgent } from "@terragon/agent/utils";
import {
  DBUserMessage,
  ThreadErrorMessage,
  ThreadInfoFull,
  ThreadStatus,
} from "@terragon/shared";
import {
  buildRepoFileArtifactId,
  buildRepoTreeArtifactId,
} from "@terragon/shared/db/artifact-descriptors";
import { classifyRepoFileLink } from "@terragon/shared/utils/repo-file-link";
import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAgentWorking } from "@/agent/thread-status";
import {
  getCachedTranscript,
  invalidateCachedTranscript,
  seedTranscript,
} from "@/collections/thread-transcript-collection";
import {
  shouldUseSyntheticAgUiBenchmarkStream,
  useAgUiTransport,
} from "@/hooks/use-ag-ui-transport";
import {
  type ScopedRunIdState,
  selectScopedRunId,
  useCurrentRunId,
} from "@/hooks/use-current-run-id";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePlatform } from "@/hooks/use-platform";
import { ThreadIntentProvider } from "@/hooks/use-thread-intent";
import { useScrollToBottom } from "@/hooks/useScrollToBottom";
import { fetchAgUiHistoryMessages } from "@/lib/ag-ui-history-fetch";
import { threadDiffQueryOptions } from "@/queries/thread-queries";
import {
  type ChatUICoreData,
  type ChatUIDialogData,
  type ChatUIErrorState,
  ChatUILayout,
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
import { ThreadProvider, useThreadContext } from "./thread-provider";
import {
  createOptimisticPermissionModeUpdatedEvent,
  createOptimisticQueuedMessagesUpdatedEvent,
  createOptimisticUserSubmittedEvent,
  createRepoFileOpenedEvent,
  createRepoTreeOpenedEvent,
} from "./thread-view-model/optimistic-events";
import { useThreadViewModel } from "./use-ag-ui-messages";
import {
  useAutoOpenPanelOnNewPlan,
  useAutoOpenSecondaryPanelOnDiff,
  useInvalidateCreditBalanceOnAgentIdle,
} from "./use-chat-effects";
import { useChatViewSnapshot } from "./use-chat-view-snapshot";
import { useProductSidecars } from "./use-product-sidecars";
import { useCreateThreadIntentSubscriber } from "./use-thread-intent-handler";
import {
  useReconcileActiveChatFromServer,
  useRetryThreadMutation,
} from "./use-thread-mutations";

export async function loadAgUiHistoryMessagesForRuntime({
  threadId,
  threadChatId,
  isAgentCurrentlyWorking,
  fallbackMessages = [],
}: {
  threadId: string;
  threadChatId: string;
  isAgentCurrentlyWorking: boolean;
  fallbackMessages?: AgUiMessage[];
}) {
  // Stale-while-revalidate against the transcript collection.
  //
  // 1. If an active run has a cached snapshot (warmed by sidebar prefetch
  //    or a prior visit), return it synchronously so the runtime hydrates
  //    instantly with no "Loading task history..." placeholder.
  //
  // 2. Once a run is idle/finalized, bypass the stale cache and load the
  //    authoritative history before replacing runtime state. A user-only
  //    cached snapshot can otherwise hide the assistant response that just
  //    finished streaming.
  const cached = isAgentCurrentlyWorking
    ? getCachedTranscript(threadId, threadChatId)
    : undefined;
  if (cached !== undefined) {
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

  try {
    const fresh = await fetchAgUiHistoryMessages({ threadId, threadChatId });
    seedTranscript({ threadId, threadChatId, result: fresh });
    return fresh;
  } catch (error) {
    if (fallbackMessages.length === 0) {
      throw error;
    }
    const fallback = { messages: fallbackMessages, lastSeq: -1 };
    seedTranscript({ threadId, threadChatId, result: fallback });
    return fallback;
  }
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
  const repoFilePreviewEnabled = useFeatureFlag("repoFilePreview");
  const [error, setError] = useState<ThreadErrorMessage | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
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

  const agUiTransport = useAgUiTransport({
    threadId,
    threadChatId,
    runId: capturedRunId,
  });
  const agent = agUiTransport.agent;
  const observedRunId = useCurrentRunId(agent);
  useEffect(() => {
    // Pin the captured runId to the latest RUN_STARTED on the current
    // HttpAgent. Reset on agent identity change (thread switch) so a stale
    // runId from a previous chat never leaks into a new reconnect URL.
    setCapturedRun((current) => {
      if (
        current?.threadId === threadId &&
        current.threadChatId === threadChat.id &&
        current.runId === observedRunId
      ) {
        return current;
      }

      return {
        threadId,
        threadChatId: threadChat.id,
        runId: observedRunId,
      };
    });
  }, [observedRunId, threadChat.id, threadId]);

  const threadViewModel = useThreadViewModel({
    snapshot: threadViewSnapshot,
    includeTranscriptMessages: false,
  });
  useProductSidecars({
    agent,
    threadId,
    threadChatId,
    dispatchThreadViewEvent: threadViewModel.dispatchThreadViewEvent,
  });
  const queuedMessages = threadViewModel.queuedMessages;
  const artifactDescriptors = threadViewModel.artifacts.descriptors;
  const shouldAutoRenderSecondaryPanel =
    platform === "desktop" &&
    shouldAutoOpenSecondaryPanel &&
    hasLiveDiffSignal &&
    artifactDescriptors.length > 0;
  const shouldRenderSecondaryPanel =
    isSecondaryPanelOpen || shouldAutoRenderSecondaryPanel;

  useAutoOpenSecondaryPanelOnDiff({
    hasArtifactDescriptors: artifactDescriptors.length > 0,
    hasLiveDiffSignal,
    shouldAutoOpenSecondaryPanel,
    isSecondaryPanelOpen,
    setIsSecondaryPanelOpen,
  });

  const dispatch = threadViewModel.dispatchThreadViewEvent;
  const onOptimisticPermissionModeUpdate = useCallback(
    (mode: "allowAll" | "plan") =>
      dispatch(createOptimisticPermissionModeUpdatedEvent(mode)),
    [dispatch],
  );

  const handleOpenArtifact = useCallback(
    (artifactId: string) => {
      setActiveArtifactId(artifactId);
      setIsSecondaryPanelOpen(true);
    },
    [setIsSecondaryPanelOpen],
  );

  // Producer for every file-path affordance (markdown links, Read/Write/Edit/
  // MultiEdit/FileChange renderers, the git-diff header and file tree). A
  // clicked in-repo path is classified and dispatched as a `repo-file.opened`
  // event; the reducer synthesizes the descriptor into `state.artifacts` (the
  // one path every artifact flows through), then we focus its tab. The reducer
  // re-seeds from the snapshot on chat switch, so previews never leak across
  // chats without any manual reset here.
  // The path of the most recently opened repo file. The file tree highlights
  // it ("you are here") when the Files tab is shown.
  const [activeRepoFilePath, setActiveRepoFilePath] = useState<string | null>(
    null,
  );
  const handleOpenRepoFile = useCallback(
    (href: string) => {
      const classified = classifyRepoFileLink(href);
      if (!classified) return;
      // Mirror the server's ref-resolution rule (get-repo-file-content.ts):
      // working branch when present, else base branch. Keeps the descriptor id
      // and label consistent with the ref the content is actually read from.
      const ref = thread.branchName ?? thread.repoBaseBranchName ?? undefined;
      setActiveRepoFilePath(classified.path);
      dispatch(
        createRepoFileOpenedEvent({
          path: classified.path,
          ref,
          lineRange: classified.lineRange,
        }),
      );
      handleOpenArtifact(
        buildRepoFileArtifactId({ path: classified.path, ref }),
      );
    },
    [
      dispatch,
      handleOpenArtifact,
      thread.branchName,
      thread.repoBaseBranchName,
    ],
  );
  // Gate the producer on the feature flag: when off, the callback is undefined
  // end-to-end so in-repo links keep their default new-tab navigation.
  const onOpenRepoFile = repoFilePreviewEnabled
    ? handleOpenRepoFile
    : undefined;

  // Opens the repo file tree as a singleton artifact tab, resolving the ref the
  // same way handleOpenRepoFile does so the tree and previews share a ref.
  const handleOpenRepoTree = useCallback(() => {
    const ref = thread.branchName ?? thread.repoBaseBranchName ?? undefined;
    dispatch(createRepoTreeOpenedEvent({ ref }));
    handleOpenArtifact(buildRepoTreeArtifactId({ ref }));
  }, [
    dispatch,
    handleOpenArtifact,
    thread.branchName,
    thread.repoBaseBranchName,
  ]);
  const onOpenRepoTree = repoFilePreviewEnabled
    ? handleOpenRepoTree
    : undefined;

  const toolProps = useMemo(
    () => ({
      threadId,
      threadChatId: threadViewModel.threadChatId,
      isReadOnly,
      promptBoxRef,
      childThreads: shell.childThreads ?? [],
      githubRepoFullName: thread.githubRepoFullName ?? "",
      repoBaseBranchName: thread.repoBaseBranchName ?? "main",
      branchName: thread.branchName ?? null,
      onOptimisticPermissionModeUpdate,
      onOpenRepoFile,
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
      onOpenRepoFile,
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

  useAutoOpenPanelOnNewPlan({
    artifactDescriptors,
    shouldAutoOpenSecondaryPanel,
    threadId,
    onOpenArtifact: handleOpenArtifact,
  });

  const effectiveThreadStatus = threadViewModel.lifecycle.threadStatus;
  const syntheticAgUiBenchmarkStream = shouldUseSyntheticAgUiBenchmarkStream();
  const isAgentCurrentlyWorking =
    syntheticAgUiBenchmarkStream ||
    (effectiveThreadStatus !== null && isAgentWorking(effectiveThreadStatus));
  const loadAgUiHistoryMessages = useCallback(
    () =>
      loadAgUiHistoryMessagesForRuntime({
        threadId,
        threadChatId,
        isAgentCurrentlyWorking,
        fallbackMessages: threadViewSnapshot.agUiInitialMessages,
      }),
    [
      isAgentCurrentlyWorking,
      threadChatId,
      threadId,
      threadViewSnapshot.agUiInitialMessages,
    ],
  );
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
      dispatch(
        createOptimisticUserSubmittedEvent({
          message: userMessage,
          optimisticStatus,
        }),
      );
    },
    [dispatch],
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
            setReplayCursor: agUiTransport.setReplayCursor,
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
      agUiTransport.setReplayCursor,
    ],
  );

  const viewModel = useMemo<ChatUIViewModelData>(
    () => ({
      threadViewModel,
      loadAgUiHistoryMessages,
      queuedMessages,
      artifactDescriptors,
      effectiveThreadStatus,
      isAgentCurrentlyWorking,
      toolProps,
      lastUsedModel,
      handleOpenArtifact,
      onOpenRepoFile,
      onOpenRepoTree,
      activeRepoFilePath,
    }),
    [
      artifactDescriptors,
      effectiveThreadStatus,
      handleOpenArtifact,
      onOpenRepoFile,
      onOpenRepoTree,
      activeRepoFilePath,
      isAgentCurrentlyWorking,
      lastUsedModel,
      loadAgUiHistoryMessages,
      queuedMessages,
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

  const subscriber = useCreateThreadIntentSubscriber({
    setError,
    refetch: reconcileActiveChatFromServer,
  });

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
    <ThreadIntentProvider subscriber={subscriber}>
      <ChatUILayout
        coreData={coreData}
        viewModel={viewModel}
        scrollState={scrollState}
        panelState={panelState}
        dialogData={dialogData}
        optimisticHandlers={optimisticHandlers}
        errorState={errorState}
      />
    </ThreadIntentProvider>
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
