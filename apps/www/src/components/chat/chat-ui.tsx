"use client";

import React, {
  memo,
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
} from "react";
import {
  DBMessage,
  DBUserMessage,
  ThreadErrorMessage,
  ThreadStatus,
  GithubPRStatus,
  GithubCheckStatus,
  ThreadChatInfoFull,
} from "@terragon/shared";
import { AIAgent } from "@terragon/agent/types";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import { useIncrementalUIMessages } from "./toUIMessages";
import {
  ChatMessages,
  WorkingMessage,
  MessageScheduled,
} from "./chat-messages";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChatHeader } from "./chat-header";
import { useScrollToBottom } from "@/hooks/useScrollToBottom";
import { followUp, queueFollowUp } from "@/server-actions/follow-up";
import { retryThread } from "@/server-actions/retry-thread";
import { retryGitCheckpoint } from "@/server-actions/retry-git-checkpoint";
import { stopThread } from "@/server-actions/stop-thread";
import { ChatError } from "./chat-error";
import { ThreadPromptBox } from "@/components/promptbox/thread-promptbox";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  threadChatQueryOptions,
  threadDiffQueryOptions,
  threadQueryKeys,
  threadShellQueryOptions,
} from "@/queries/thread-queries";
import { isAgentWorking } from "@/agent/thread-status";
import {
  useMarkChatAsRead,
  useOptimisticUpdateThreadChat,
  useSecondaryPanel,
  useThreadDocumentTitleAndFavicon,
} from "./hooks";
import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  convertToPlainText,
  getLastUserMessageModel,
} from "@/lib/db-message-helpers";
import { ContextChip } from "./context-chip";
import { ContextWarning } from "./context-warning";
import { LeafLoading } from "./leaf-loading";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { useDeliveryLoopStatusRealtime } from "@/hooks/use-delivery-loop-status-realtime";
import { HandleSubmit } from "../promptbox/use-promptbox";
import { USER_CREDIT_BALANCE_QUERY_KEY } from "@/queries/user-credit-balance-queries";
import { ensureAgent } from "@terragon/agent/utils";
import { getArtifactDescriptors } from "@terragon/shared/db/artifact-descriptors";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import { unwrapError } from "@/lib/server-actions";
import { usePlatform } from "@/hooks/use-platform";
import dynamic from "next/dynamic";
import { ThreadInfoFull } from "@terragon/shared";
import { applyThreadPatchToQueryClient } from "@/queries/thread-patch-cache";
import { useDeltaAccumulator } from "@/hooks/useDeltaAccumulator";
import {
  seedShell,
  applyShellPatchToCollection,
  useShellFromCollection,
} from "@/collections/thread-shell-collection";
import {
  seedChat,
  applyChatPatchToCollection,
  useChatFromCollection,
} from "@/collections/thread-chat-collection";
import { applyThreadPatchToCollection } from "@/collections/thread-info-collection";
import { useDeliveryLoopStatusQuery } from "@/queries/delivery-loop-status-queries";
import { getDeliveryLoopAwareThreadStatus } from "@/lib/delivery-loop-status";

function isThreadStatusWorking(status: ThreadStatus): boolean {
  return [
    "queued",
    "queued-tasks-concurrency",
    "queued-sandbox-creation-rate-limit",
    "queued-agent-rate-limit",
    "booting",
    "working",
    "stopping",
    "checkpointing",
  ].includes(status);
}

const TerminalPanel = dynamic(
  () => import("./terminal-panel").then((mod) => mod.TerminalPanel),
  { ssr: false },
);

const SecondaryPanel = dynamic(
  () => import("./secondary-panel").then((mod) => mod.SecondaryPanel),
  { ssr: false },
);

const DeliveryLoopTopProgressStepper = dynamic(
  () =>
    import("@/components/patterns/delivery-loop-top-progress-stepper").then(
      (mod) => mod.DeliveryLoopTopProgressStepper,
    ),
  { ssr: false },
);

function getInitialUserMessage(messages: DBMessage[]) {
  let messageModel: DBUserMessage["model"] = null;
  const initialUserMessage: DBUserMessage = {
    type: "user",
    model: null,
    parts: [],
  };

  for (const message of messages) {
    if (message.type === "user") {
      if (!messageModel && message.model) {
        messageModel = message.model;
        initialUserMessage.model = message.model;
      }
      initialUserMessage.parts.push(...message.parts);
      continue;
    }
    if (
      message.type === "stop" ||
      message.type === "error" ||
      message.type === "meta"
    ) {
      continue;
    }
    break;
  }

  return initialUserMessage;
}

function ChatUI({
  threadId,
  isReadOnly,
}: {
  threadId: string;
  isReadOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const { messagesEndRef, isAtBottom, forceScrollToBottom } = useScrollToBottom(
    {
      observedRef: transcriptRef,
    },
  );
  const [error, setError] = useState<ThreadErrorMessage | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const platform = usePlatform();
  const [showTerminal, setShowTerminal] = useState(false);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const {
    shouldAutoOpenSecondaryPanel,
    isSecondaryPanelOpen,
    setIsSecondaryPanelOpen,
  } = useSecondaryPanel();

  const promptBoxRef = useRef<{
    focus: () => void;
    setPermissionMode: (mode: "allowAll" | "plan") => void;
  } | null>(null);

  // TanStack DB collection is the primary read path (reactive to WebSocket patches).
  // React Query fetches in the background and seeds collections on delivery.
  // Hover-prefetch (prefetch.ts) pre-populates before mount for instant switching.
  const { data: shellFromQuery, isLoading: isShellFetching } = useQuery({
    ...threadShellQueryOptions(threadId),
  });
  useEffect(() => {
    if (shellFromQuery) seedShell(shellFromQuery);
  }, [shellFromQuery]);

  const shellFromCollection = useShellFromCollection(threadId);
  const shell = shellFromCollection ?? shellFromQuery ?? null;
  const isShellLoading = !shell && isShellFetching;

  const threadChatId = shell?.primaryThreadChatId;
  const { data: chatFromQuery, isLoading: isChatFetching } = useQuery({
    ...(threadChatId
      ? threadChatQueryOptions({ threadId, threadChatId })
      : threadChatQueryOptions({
          threadId,
          threadChatId: "missing-thread-chat-id",
        })),
    enabled: threadChatId !== undefined,
  });
  useEffect(() => {
    if (chatFromQuery) seedChat(chatFromQuery);
  }, [chatFromQuery]);

  const chatFromCollection = useChatFromCollection(threadId, threadChatId);
  const threadChat = chatFromCollection ?? chatFromQuery ?? null;
  const isThreadChatLoading = !threadChat && isChatFetching;
  const realtimeReplayBaseline = useMemo(() => {
    const canonicalMessageSeq = Math.max(
      shell?.primaryThreadChat.messageSeq ?? 0,
      threadChat?.messageSeq ?? 0,
    );

    return canonicalMessageSeq > 0 ? { messageSeq: canonicalMessageSeq } : null;
  }, [shell?.primaryThreadChat.messageSeq, threadChat?.messageSeq]);

  const dbMessages = useMemo(
    () => (threadChat?.messages as DBMessage[]) ?? [],
    [threadChat?.messages],
  );
  const queuedMessages = useMemo(
    () =>
      threadChat?.queuedMessages?.length
        ? (threadChat.queuedMessages as DBUserMessage[])
        : null,
    [threadChat?.queuedMessages],
  );
  const hasLiveDiffSignal = Boolean(
    shell?.hasGitDiff || (shell?.gitDiffStats?.files ?? 0) > 0,
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

  const threadPreviewChat = useMemo<ThreadChatInfoFull | null>(() => {
    if (!shell) {
      return null;
    }
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
      messages: [],
      queuedMessages: null,
      sessionId: null,
      errorMessage: shell.primaryThreadChat.errorMessage,
      errorMessageInfo: shell.primaryThreadChat.errorMessageInfo,
      scheduleAt: shell.primaryThreadChat.scheduleAt,
      reattemptQueueAt: shell.primaryThreadChat.reattemptQueueAt,
      contextLength: shell.primaryThreadChat.contextLength,
      permissionMode: shell.primaryThreadChat.permissionMode,
      codexPreviousResponseId: null,
      messageSeq: 0,
      isUnread: shell.primaryThreadChat.isUnread,
    };
  }, [shell]);

  const thread = useMemo<ThreadInfoFull | null>(() => {
    if (!shell || !threadPreviewChat) {
      return null;
    }
    const {
      hasGitDiff: _hasGitDiff,
      primaryThreadChatId: _primaryThreadChatId,
      primaryThreadChat: _primaryThreadChat,
      ...threadShell
    } = shell;
    return {
      ...threadShell,
      gitDiff: threadDiff?.gitDiff ?? null,
      gitDiffStats:
        threadDiff?.gitDiffStats ?? threadShell.gitDiffStats ?? null,
      threadChats: [threadPreviewChat],
      childThreads: shell.childThreads,
      parentThreadName: shell.parentThreadName,
    };
  }, [shell, threadDiff, threadPreviewChat]);

  const isDeliveryLoopOptedIn =
    shell?.sourceType === "www" &&
    shell.sourceMetadata?.type === "www" &&
    shell.sourceMetadata.deliveryLoopOptIn;
  const shouldShowDeliveryLoopStatus =
    Boolean(isDeliveryLoopOptedIn) || Boolean(shell?.githubPRNumber);
  const hasAnyDiffSignal = hasLiveDiffSignal;

  // Auto-open secondary panel when gitDiff exists (only once, desktop only)
  // This will set the cookie if the panel is opened automatically
  useEffect(() => {
    if (
      hasAnyDiffSignal &&
      shouldAutoOpenSecondaryPanel &&
      !isSecondaryPanelOpen
    ) {
      setIsSecondaryPanelOpen(true);
    }
  }, [
    hasAnyDiffSignal,
    isSecondaryPanelOpen,
    setIsSecondaryPanelOpen,
    shouldAutoOpenSecondaryPanel,
  ]);
  useThreadDocumentTitleAndFavicon({
    name: shell?.name ?? "",
    isThreadUnread: !!shell?.isUnread,
    isReadOnly,
  });
  useMarkChatAsRead({
    threadId,
    threadChatId,
    threadIsUnread: !!shell?.isUnread,
    isReadOnly,
  });
  const { deltas, applyDelta, clearDeltasForThread } = useDeltaAccumulator();
  const handleThreadPatches = useCallback(
    (patches: BroadcastThreadPatch[]) => {
      let hasMaterializedMessages = false;
      let latestPatchedStatus: ThreadStatus | null = null;
      for (const patch of patches) {
        if (patch.op === "delta") {
          applyDelta(patch);
        } else {
          if (patch.chat?.status) {
            latestPatchedStatus = patch.chat.status;
          }
          if (
            patch.appendMessages !== undefined &&
            patch.appendMessages.length > 0 &&
            patch.appendMessages.some(
              (message) =>
                typeof message === "object" &&
                message !== null &&
                "type" in message &&
                (message as { type?: unknown }).type === "agent",
            )
          ) {
            hasMaterializedMessages = true;
          }
          // Write to TanStack DB collections (primary data path)
          applyShellPatchToCollection(patch);
          applyChatPatchToCollection(patch);
          applyThreadPatchToCollection(patch);
          // Dual-write to React Query cache (diff invalidation + legacy consumers)
          applyThreadPatchToQueryClient({ queryClient, patch });
        }
      }
      // When a complete message arrives, clear accumulated deltas since the
      // DB message now contains the full text.
      if (
        hasMaterializedMessages &&
        latestPatchedStatus != null &&
        !isThreadStatusWorking(latestPatchedStatus)
      ) {
        clearDeltasForThread();
      }
    },
    [applyDelta, clearDeltasForThread, queryClient],
  );
  useDeliveryLoopStatusRealtime({
    threadId,
    threadChatId,
    enabled: shouldShowDeliveryLoopStatus,
    onThreadPatches: handleThreadPatches,
    replayBaseline: realtimeReplayBaseline ?? undefined,
  });

  const chatAgent = ensureAgent(threadChat?.agent);
  const hasCheckpoint = useMemo(
    () => dbMessages.some((message) => message.type === "git-diff"),
    [dbMessages],
  );
  const latestGitDiffTimestamp = useMemo(() => {
    for (let index = dbMessages.length - 1; index >= 0; index--) {
      const message = dbMessages[index];
      if (message?.type === "git-diff") {
        return message.timestamp ?? null;
      }
    }
    return null;
  }, [dbMessages]);
  const lastUsedModel = useMemo(
    () => getLastUserMessageModel(dbMessages),
    [dbMessages],
  );
  const initialUserMessage = useMemo(
    () => getInitialUserMessage(dbMessages),
    [dbMessages],
  );
  const redoDialogData = useMemo(
    () => ({
      threadId,
      repoFullName: thread?.githubRepoFullName ?? "",
      repoBaseBranchName: thread?.repoBaseBranchName ?? "main",
      disableGitCheckpointing: thread?.disableGitCheckpointing ?? false,
      skipSetup: thread?.skipSetup ?? false,
      permissionMode: threadChat?.permissionMode ?? "allowAll",
      initialUserMessage,
    }),
    [
      initialUserMessage,
      thread?.disableGitCheckpointing,
      thread?.githubRepoFullName,
      thread?.repoBaseBranchName,
      thread?.skipSetup,
      threadChat?.permissionMode,
      threadId,
    ],
  );
  const forkDialogData = useMemo(
    () => ({
      threadId,
      threadChatId: threadChat?.id ?? "",
      repoFullName: thread?.githubRepoFullName ?? "",
      repoBaseBranchName: thread?.repoBaseBranchName ?? "main",
      branchName: thread?.branchName ?? null,
      gitDiffStats: thread?.gitDiffStats ?? null,
      disableGitCheckpointing: thread?.disableGitCheckpointing ?? false,
      skipSetup: thread?.skipSetup ?? false,
      agent: chatAgent,
      lastSelectedModel: lastUsedModel,
    }),
    [
      chatAgent,
      lastUsedModel,
      thread?.branchName,
      thread?.disableGitCheckpointing,
      thread?.gitDiffStats,
      thread?.githubRepoFullName,
      thread?.repoBaseBranchName,
      thread?.skipSetup,
      threadChat?.id,
      threadId,
    ],
  );
  const toolProps = useMemo(
    () => ({
      threadId,
      threadChatId: threadChat?.id ?? "",
      messages: dbMessages,
      isReadOnly,
      promptBoxRef,
      childThreads: shell?.childThreads ?? [],
      githubRepoFullName: thread?.githubRepoFullName ?? "",
      repoBaseBranchName: thread?.repoBaseBranchName ?? "main",
      branchName: thread?.branchName ?? null,
    }),
    [
      dbMessages,
      isReadOnly,
      shell?.childThreads,
      thread?.branchName,
      thread?.githubRepoFullName,
      thread?.repoBaseBranchName,
      threadChat?.id,
      threadId,
    ],
  );
  const { data: deliveryLoopStatus } = useDeliveryLoopStatusQuery({
    threadId,
    enabled: shouldShowDeliveryLoopStatus,
  });
  const effectiveThreadStatus = useMemo(
    () =>
      getDeliveryLoopAwareThreadStatus({
        threadStatus: threadChat?.status ?? null,
        deliveryLoopState: deliveryLoopStatus?.state,
      }),
    [deliveryLoopStatus?.state, threadChat?.status],
  );
  const messages = useIncrementalUIMessages({
    dbMessages,
    agent: chatAgent,
    threadStatus: threadChat?.status,
    cacheKey: threadChatId ?? threadId,
    deltas,
  });
  const artifactDescriptors = useMemo(
    () =>
      getArtifactDescriptors({
        messages,
        thread: thread
          ? {
              id: thread.id,
              updatedAt: thread.updatedAt,
              gitDiff: thread.gitDiff,
              gitDiffStats: thread.gitDiffStats,
            }
          : null,
      }),
    [messages, thread],
  );
  const handleOpenArtifact = useCallback(
    (artifactId: string) => {
      setActiveArtifactId(artifactId);
      setIsSecondaryPanelOpen(true);
    },
    [setIsSecondaryPanelOpen],
  );

  // Auto-open panel when new plan artifacts appear
  const seenPlanIdsRef = useRef<Set<string>>(new Set());
  const prevThreadIdRef = useRef(threadId);
  useEffect(() => {
    const planDescriptors = artifactDescriptors.filter(
      (d) => d.kind === "plan",
    );

    // On thread switch, seed with all current plan IDs so existing plans aren't treated as new
    if (prevThreadIdRef.current !== threadId) {
      prevThreadIdRef.current = threadId;
      seenPlanIdsRef.current = new Set(planDescriptors.map((d) => d.id));
      return;
    }

    if (!shouldAutoOpenSecondaryPanel) return;

    const newPlan = planDescriptors.findLast(
      (d) => !seenPlanIdsRef.current.has(d.id),
    );

    for (const d of planDescriptors) {
      seenPlanIdsRef.current.add(d.id);
    }

    if (newPlan) {
      handleOpenArtifact(newPlan.id);
    }
  }, [
    artifactDescriptors,
    shouldAutoOpenSecondaryPanel,
    handleOpenArtifact,
    threadId,
  ]);

  const isAgentCurrentlyWorking =
    effectiveThreadStatus !== null && isAgentWorking(effectiveThreadStatus);
  const previousAgentWorkingRef = useRef<boolean | null>(null);

  useEffect(() => {
    const previousIsWorking = previousAgentWorkingRef.current;

    if (
      previousIsWorking !== null &&
      previousIsWorking !== isAgentCurrentlyWorking &&
      !isAgentCurrentlyWorking
    ) {
      void queryClient.invalidateQueries({
        queryKey: USER_CREDIT_BALANCE_QUERY_KEY,
      });
    }

    previousAgentWorkingRef.current = isAgentCurrentlyWorking;
  }, [isAgentCurrentlyWorking, queryClient]);

  const hasScrolledRef = useRef(false);

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

  useEffect(() => {
    if (hasScrolledRef.current || !messages.length || !window.location.hash)
      return;

    const hash = window.location.hash.slice(1); // Remove the #
    const match = hash.match(/^message-(\d+)$/);
    if (!match || !match[1]) return;

    const targetIndex = parseInt(match[1], 10);
    if (targetIndex < 0 || targetIndex >= messages.length) return;

    // Small delay to ensure DOM is rendered
    setTimeout(() => {
      const targetElement = document.querySelector(
        `[data-message-index="${targetIndex}"]`,
      );
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 100);

    hasScrolledRef.current = true;
  }, [messages]); // Depend on messages array reference

  const retryMutation = useServerActionMutation({
    mutationFn: async () => {
      if (
        threadChat?.errorMessage === "git-checkpoint-push-failed" ||
        threadChat?.errorMessage === "git-checkpoint-diff-failed"
      ) {
        return await retryGitCheckpoint({
          threadId,
          threadChatId: threadChatId!,
        });
      } else {
        return await retryThread({ threadId, threadChatId: threadChatId! });
      }
    },
    onMutate: () => {
      setError(null);
    },
    onSuccess: () => {
      if (threadChatId) {
        void queryClient.invalidateQueries({
          queryKey: threadQueryKeys.chat(threadId, threadChatId),
        });
      }
      void queryClient.invalidateQueries({
        queryKey: threadQueryKeys.shell(threadId),
      });
    },
    onError: (error) => {
      setError(unwrapError(error));
    },
  });

  const handleRetry = async () => {
    if (isReadOnly) {
      throw new Error("Cannot retry thread in read-only mode");
    }
    await retryMutation.mutateAsync();
  };

  const refetchActiveChat = useCallback(() => {
    if (!threadChatId) {
      return Promise.resolve();
    }
    return queryClient.invalidateQueries({
      queryKey: threadQueryKeys.chat(threadId, threadChatId),
    });
  }, [queryClient, threadChatId, threadId]);

  if (
    isShellLoading ||
    isThreadChatLoading ||
    !thread ||
    !threadChat ||
    !shell
  ) {
    return (
      <div className="flex flex-col h-[100dvh] w-full items-center justify-center">
        <LeafLoading message="Loading task…" />
      </div>
    );
  }
  return (
    <>
      <div className="flex flex-col h-[100dvh] w-full">
        <ChatHeader
          thread={thread}
          threadAgent={chatAgent}
          redoDialogData={redoDialogData}
          isReadOnly={isReadOnly}
          onHeaderClick={platform === "mobile" ? scrollToTop : undefined}
          onTerminalClick={() => setShowTerminal(true)}
        />
        {shouldShowDeliveryLoopStatus ? (
          <DeliveryLoopTopProgressStepper
            threadId={threadId}
            threadChatId={threadChatId ?? null}
            enabled={true}
          />
        ) : null}
        <div ref={chatContainerRef} className="flex flex-1 overflow-hidden">
          <div className="flex-1 flex flex-col overflow-hidden">
            <ScrollArea
              ref={scrollAreaRef}
              className="w-full h-full overflow-auto"
            >
              <div
                ref={transcriptRef}
                className="flex flex-col flex-1 gap-8 w-full max-w-chat mx-auto px-6 mt-12 mb-20"
              >
                <ChatMessages
                  messages={messages}
                  isAgentWorking={isAgentCurrentlyWorking}
                  thread={thread}
                  latestGitDiffTimestamp={latestGitDiffTimestamp}
                  githubRepoFullName={thread.githubRepoFullName}
                  branchName={thread.branchName}
                  baseBranchName={thread.repoBaseBranchName}
                  hasCheckpoint={hasCheckpoint}
                  toolProps={toolProps}
                  redoDialogData={redoDialogData}
                  forkDialogData={forkDialogData}
                  artifactDescriptors={artifactDescriptors}
                  onOpenArtifact={handleOpenArtifact}
                />
                {(error ||
                  threadChat.errorMessage ||
                  threadChat.errorMessageInfo) && (
                  <ChatError
                    status={effectiveThreadStatus ?? threadChat.status}
                    errorType={threadChat.errorMessage || ""}
                    errorInfo={
                      error ||
                      threadChat.errorMessageInfo ||
                      "An unknown error occurred"
                    }
                    handleRetry={handleRetry}
                    isReadOnly={isReadOnly}
                    isRetrying={retryMutation.isPending}
                  />
                )}
                {isAgentCurrentlyWorking && (
                  <WorkingMessage
                    agent={chatAgent}
                    status={effectiveThreadStatus ?? "working"}
                    bootingSubstatus={thread.bootingSubstatus ?? undefined}
                    reattemptQueueAt={threadChat.reattemptQueueAt ?? null}
                  />
                )}
                {threadChat.status === "scheduled" && threadChat.scheduleAt && (
                  <MessageScheduled
                    threadId={threadChat.threadId}
                    threadChatId={threadChat.id}
                    scheduleAt={threadChat.scheduleAt}
                  />
                )}
              </div>
              <div
                ref={messagesEndRef}
                className="shrink-0 min-w-[24px] min-h-[24px]"
              />
              {!isReadOnly && (
                <ChatPromptBox
                  threadId={thread.id}
                  threadChatId={threadChat.id}
                  threadStatus={effectiveThreadStatus}
                  queuedMessages={queuedMessages}
                  permissionMode={threadChat.permissionMode ?? "allowAll"}
                  prStatus={thread.prStatus}
                  prChecksStatus={thread.prChecksStatus}
                  githubPRNumber={thread.githubPRNumber}
                  sandboxId={thread.codesandboxId}
                  repoFullName={thread.githubRepoFullName}
                  branchName={thread.branchName ?? thread.repoBaseBranchName}
                  agent={chatAgent}
                  agentVersion={threadChat.agentVersion}
                  lastUsedModel={lastUsedModel}
                  contextLength={threadChat.contextLength ?? null}
                  setError={setError}
                  refetch={refetchActiveChat}
                  forceScrollToBottom={forceScrollToBottom}
                  isAtBottom={isAtBottom}
                  promptBoxRef={promptBoxRef}
                />
              )}
            </ScrollArea>
          </div>
          {shouldRenderSecondaryPanel ? (
            <SecondaryPanel
              thread={thread}
              artifactDescriptors={artifactDescriptors}
              activeArtifactId={activeArtifactId}
              onActiveArtifactChange={setActiveArtifactId}
              containerRef={chatContainerRef}
              messages={dbMessages}
              threadChatId={threadChat.id}
              isReadOnly={isReadOnly}
              promptBoxRef={promptBoxRef}
            />
          ) : null}
        </div>
      </div>
      {showTerminal && thread.codesandboxId && (
        <TerminalPanel
          threadId={thread.id}
          sandboxId={thread.codesandboxId}
          sandboxProvider={thread.sandboxProvider}
          onClose={() => setShowTerminal(false)}
        />
      )}
    </>
  );
}

const ChatPromptBox = memo(function ChatPromptBox({
  threadId,
  threadChatId,
  threadStatus,
  queuedMessages,
  permissionMode,
  prStatus,
  prChecksStatus,
  githubPRNumber,
  sandboxId,
  repoFullName,
  branchName,
  agent,
  agentVersion,
  lastUsedModel,
  contextLength,
  setError,
  refetch,
  isAtBottom,
  forceScrollToBottom,
  promptBoxRef,
}: {
  threadId: string;
  threadChatId: string;
  threadStatus: ThreadStatus | null;
  queuedMessages: DBUserMessage[] | null;
  permissionMode: "allowAll" | "plan";
  prStatus: GithubPRStatus | null;
  prChecksStatus: GithubCheckStatus | null;
  githubPRNumber: number | null;
  sandboxId: string | null;
  repoFullName: string;
  branchName: string;
  agent: AIAgent;
  agentVersion: number;
  lastUsedModel: ReturnType<typeof getLastUserMessageModel>;
  contextLength: number | null;
  setError: (error: ThreadErrorMessage | null) => void;
  isAtBottom: boolean;
  forceScrollToBottom: () => void;
  refetch: () => Promise<unknown>;
  promptBoxRef: React.RefObject<{
    focus: () => void;
    setPermissionMode: (mode: "allowAll" | "plan") => void;
  } | null>;
}) {
  const chatAgent = ensureAgent(agent);
  const showContextUsageChip = useFeatureFlag("contextUsageChip");
  // Don't immediately show the scroll button - wait for the page to scroll to the bottom first.
  const [hasInitialized, setHasInitialized] = useState(false);
  useEffect(() => {
    // Defer one frame so the scroll observer can emit its first value,
    // then mark as initialized. This prevents a flash before the auto-scroll-to-bottom runs.
    const raf = requestAnimationFrame(() => setHasInitialized(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const updateThreadChat = useOptimisticUpdateThreadChat({
    threadId,
    threadChatId,
  });

  const handleSubmit = useCallback<HandleSubmit>(
    async ({ userMessage }) => {
      const plainText = convertToPlainText({ message: userMessage });
      if (plainText.length === 0) {
        return;
      }
      forceScrollToBottom();
      setError(null);
      // Optimistically add the message to the thread
      const optimisticStatus =
        plainText.trim() === "/clear" ? "complete" : "booting";
      updateThreadChat((currentChat) => ({
        messages: [...(currentChat.messages ?? []), userMessage],
        errorMessage: null,
        errorMessageInfo: null,
        status: optimisticStatus,
      }));
      const followUpResult = await followUp({
        threadId,
        threadChatId,
        message: userMessage,
      });
      if (!followUpResult.success) {
        setError(followUpResult.errorMessage);
        // Revert optimistic update on error
        refetch();
        return;
      }
    },
    [
      threadId,
      threadChatId,
      updateThreadChat,
      refetch,
      setError,
      forceScrollToBottom,
    ],
  );

  const handleStop = useCallback(async () => {
    await stopThread({ threadId, threadChatId });
    await refetch();
  }, [threadId, threadChatId, refetch]);

  const updateQueuedMessages = useCallback(
    async (messages: DBUserMessage[]) => {
      updateThreadChat({ queuedMessages: messages });
      const queueFollowUpResult = await queueFollowUp({
        threadId,
        threadChatId,
        messages,
      });
      if (!queueFollowUpResult.success) {
        setError(queueFollowUpResult.errorMessage);
        refetch();
        return;
      }
    },
    [threadId, threadChatId, updateThreadChat, refetch, setError],
  );

  const handleQueueMessage = useCallback(
    async ({ userMessage }: { userMessage: DBUserMessage }) => {
      const plainText = convertToPlainText({ message: userMessage });
      if (plainText.length === 0) {
        return;
      }
      updateQueuedMessages([...(queuedMessages ?? []), userMessage]);
    },
    [queuedMessages, updateQueuedMessages],
  );

  return (
    <div className="sticky bottom-0 z-10 bg-background/95 backdrop-blur-sm chat-prompt-box px-6 pb-8 max-w-chat w-full mx-auto [mask-image:linear-gradient(to_bottom,transparent,black_40px)]">
      <div className="relative h-0 flex justify-center">
        <button
          onClick={forceScrollToBottom}
          className={cn(
            "absolute -top-16 z-20 flex size-9 items-center justify-center rounded-full bg-background border shadow-card transition-all duration-300 hover:scale-110",
            hasInitialized && !isAtBottom
              ? "opacity-100 translate-y-0"
              : "opacity-0 translate-y-4 pointer-events-none",
          )}
          aria-label="Scroll to bottom"
        >
          <ArrowDown className="size-5" />
        </button>
      </div>
      {showContextUsageChip ? (
        <ContextChip
          contextLength={contextLength}
          showAlways={chatAgent === "claudeCode"}
        />
      ) : (
        <ContextWarning contextLength={contextLength} />
      )}
      <ThreadPromptBox
        ref={promptBoxRef}
        threadId={threadId}
        threadChatId={threadChatId}
        status={threadStatus}
        prStatus={prStatus}
        prChecksStatus={prChecksStatus}
        githubPRNumber={githubPRNumber}
        sandboxId={sandboxId}
        repoFullName={repoFullName}
        branchName={branchName}
        agent={chatAgent}
        agentVersion={agentVersion}
        lastUsedModel={lastUsedModel}
        permissionMode={permissionMode}
        handleStop={handleStop}
        handleSubmit={handleSubmit}
        queuedMessages={queuedMessages}
        handleQueueMessage={handleQueueMessage}
        onUpdateQueuedMessage={updateQueuedMessages}
      />
    </div>
  );
});

const ChatUIMemo = memo(ChatUI);

// Client-only: useLiveQuery requires useSyncExternalStore (no getServerSnapshot).
// page.tsx still prefetches into React Query for first-visit hydration.
export default dynamic(() => Promise.resolve(ChatUIMemo), { ssr: false });
