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
  ThreadChatInfoFull,
  ThreadErrorMessage,
  ThreadInfoFull,
} from "@terragon/shared";
import { useRealtimeThread } from "@/hooks/useRealtime";
import { toUIMessages } from "./toUIMessages";
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
import { ThreadProvider } from "./thread-context";
import { ThreadPromptBox } from "@/components/promptbox/thread-promptbox";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { threadQueryOptions } from "@/queries/thread-queries";
import dynamic from "next/dynamic";
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
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { HandleSubmit } from "../promptbox/use-promptbox";
import { TerminalPanel } from "./terminal-panel";
import { USER_CREDIT_BALANCE_QUERY_KEY } from "@/queries/user-credit-balance-queries";
import { ensureAgent } from "@terragon/agent/utils";
import { SecondaryPanel } from "./secondary-panel";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import { unwrapError } from "@/lib/server-actions";
import { getPrimaryThreadChat } from "@terragon/shared/utils/thread-utils";
import { usePlatform } from "@/hooks/use-platform";
import { SdlcTopProgressStepper } from "@/components/patterns/p-stepper-7";

function ChatUI({
  threadId,
  isReadOnly,
}: {
  threadId: string;
  isReadOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const { messagesEndRef, isAtBottom, forceScrollToBottom } =
    useScrollToBottom();
  const [error, setError] = useState<ThreadErrorMessage | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const platform = usePlatform();
  const [showTerminal, setShowTerminal] = useState(false);
  const { shouldAutoOpenSecondaryPanel, setIsSecondaryPanelOpen } =
    useSecondaryPanel();

  const promptBoxRef = useRef<{
    focus: () => void;
    setPermissionMode: (mode: "allowAll" | "plan") => void;
  } | null>(null);

  // Use React Query to fetch thread data.
  const {
    data: thread,
    refetch,
    isLoading,
  } = useQuery({
    ...threadQueryOptions(threadId),
  });

  const threadChat = thread ? getPrimaryThreadChat(thread) : null;
  const threadChatId = threadChat?.id;
  const isSdlcLoopOptedIn =
    thread?.sourceType === "www" &&
    thread.sourceMetadata?.type === "www" &&
    thread.sourceMetadata.sdlcLoopOptIn;
  const shouldShowSdlcLoopStatus =
    Boolean(isSdlcLoopOptedIn) || Boolean(thread?.githubPRNumber);

  // Auto-open secondary panel when gitDiff exists (only once, desktop only)
  // This will set the cookie if the panel is opened automatically
  useEffect(() => {
    if (thread?.gitDiff && shouldAutoOpenSecondaryPanel) {
      setIsSecondaryPanelOpen(true);
      return;
    }
  }, [thread?.gitDiff, shouldAutoOpenSecondaryPanel, setIsSecondaryPanelOpen]);
  useThreadDocumentTitleAndFavicon({
    name: thread?.name ?? "",
    isThreadUnread: !!thread?.isUnread,
    isReadOnly,
  });
  useMarkChatAsRead({
    threadId,
    threadChatId,
    threadIsUnread: !!thread?.isUnread,
    isReadOnly,
  });
  useRealtimeThread(threadId, refetch);

  const messages = useMemo(() => {
    const dbMessages = (threadChat?.messages as DBMessage[]) ?? [];
    const agent = ensureAgent(threadChat?.agent);
    return toUIMessages({
      dbMessages,
      agent,
      threadStatus: threadChat?.status,
    });
  }, [threadChat]);

  const isAgentCurrentlyWorking = threadChat
    ? isAgentWorking(threadChat.status)
    : false;
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
      refetch();
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

  if (isLoading || !thread || !threadChat) {
    return (
      <div className="flex flex-col h-[100dvh] w-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }
  const chatAgent = ensureAgent(threadChat?.agent);
  return (
    <ThreadProvider
      thread={thread}
      threadChat={threadChat}
      promptBoxRef={promptBoxRef}
      isReadOnly={isReadOnly}
    >
      <div className="flex flex-col h-[100dvh] w-full">
        <ChatHeader
          thread={thread}
          isReadOnly={isReadOnly}
          onHeaderClick={platform === "mobile" ? scrollToTop : undefined}
          onTerminalClick={() => setShowTerminal(true)}
        />
        <SdlcTopProgressStepper
          threadId={threadId}
          enabled={shouldShowSdlcLoopStatus}
        />
        <div ref={chatContainerRef} className="flex flex-1 overflow-hidden">
          <div className="flex-1 flex flex-col overflow-hidden">
            <ScrollArea
              ref={scrollAreaRef}
              className="w-full h-full overflow-auto"
            >
              <div className="flex flex-col flex-1 gap-2 w-full max-w-[800px] mx-auto px-4 mt-2 mb-4">
                <ChatMessages
                  messages={messages}
                  isAgentWorking={isAgentCurrentlyWorking}
                />
                {(error ||
                  threadChat.errorMessage ||
                  threadChat.errorMessageInfo) && (
                  <ChatError
                    status={threadChat.status}
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
                    status={threadChat.status}
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
                  thread={thread}
                  threadChat={threadChat}
                  setError={setError}
                  refetch={refetch}
                  forceScrollToBottom={forceScrollToBottom}
                  isAtBottom={isAtBottom}
                  promptBoxRef={promptBoxRef}
                />
              )}
            </ScrollArea>
          </div>
          <SecondaryPanel thread={thread} containerRef={chatContainerRef} />
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
    </ThreadProvider>
  );
}

function ChatPromptBox({
  thread,
  threadChat,
  setError,
  refetch,
  isAtBottom,
  forceScrollToBottom,
  promptBoxRef,
}: {
  thread: ThreadInfoFull;
  threadChat: ThreadChatInfoFull;
  setError: (error: ThreadErrorMessage | null) => void;
  isAtBottom: boolean;
  forceScrollToBottom: () => void;
  refetch: () => void;
  promptBoxRef: React.RefObject<{
    focus: () => void;
    setPermissionMode: (mode: "allowAll" | "plan") => void;
  } | null>;
}) {
  const threadId = thread.id;
  const threadChatId = threadChat.id;
  const chatAgent = ensureAgent(threadChat.agent);
  const showContextUsageChip = useFeatureFlag("contextUsageChip");
  // Don't immediately show the scroll button - wait for the page to scroll to the bottom first.
  const [showScrollButton, setShowScrollButton] = useState(false);
  useEffect(() => {
    const timeout = setTimeout(() => {
      setShowScrollButton(true);
    }, 1000);
    return () => clearTimeout(timeout);
  }, []);

  const lastUsedModel = useMemo(() => {
    const dbMessages = (threadChat.messages as DBMessage[]) ?? [];
    return getLastUserMessageModel(dbMessages);
  }, [threadChat.messages]);

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
      updateThreadChat({
        messages: [...(threadChat.messages ?? []), userMessage],
        errorMessage: null,
        errorMessageInfo: null,
        status: optimisticStatus,
      });
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
      threadChat,
      updateThreadChat,
      refetch,
      setError,
      forceScrollToBottom,
    ],
  );

  const handleStop = useCallback(async () => {
    await stopThread({ threadId, threadChatId });
    refetch();
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
      updateQueuedMessages([...(threadChat.queuedMessages ?? []), userMessage]);
    },
    [threadChat, updateQueuedMessages],
  );

  return (
    <div className="sticky bottom-0 z-10 bg-background chat-prompt-box px-6 max-w-[800px] w-full mx-auto">
      <div className="flex h-0 items-center justify-center">
        <button
          onClick={forceScrollToBottom}
          className={cn(
            "z-20 -mt-20 flex size-8 items-center justify-center rounded-full bg-background/80 border border-foreground/20 backdrop-blur-md shadow-md transition-all duration-200 hover:bg-background/90 hover:border-foreground/30",
            showScrollButton && !isAtBottom
              ? "opacity-100 translate-y-0"
              : "opacity-0 translate-y-2 pointer-events-none",
          )}
          aria-label="Scroll to bottom"
        >
          <ArrowDown className="size-5" />
        </button>
      </div>
      {showContextUsageChip ? (
        <ContextChip
          contextLength={threadChat?.contextLength ?? null}
          showAlways={chatAgent === "claudeCode"}
        />
      ) : (
        <ContextWarning contextLength={threadChat?.contextLength ?? null} />
      )}
      <ThreadPromptBox
        ref={promptBoxRef}
        threadId={thread.id}
        threadChatId={threadChat.id}
        status={threadChat.status}
        prStatus={thread.prStatus}
        prChecksStatus={thread.prChecksStatus}
        githubPRNumber={thread.githubPRNumber}
        sandboxId={thread.codesandboxId}
        repoFullName={thread.githubRepoFullName}
        branchName={thread.branchName ?? thread.repoBaseBranchName}
        agent={chatAgent}
        agentVersion={threadChat.agentVersion}
        lastUsedModel={lastUsedModel}
        permissionMode={threadChat.permissionMode ?? "allowAll"}
        handleStop={handleStop}
        handleSubmit={handleSubmit}
        queuedMessages={
          threadChat.queuedMessages?.length
            ? (threadChat.queuedMessages as DBUserMessage[])
            : null
        }
        handleQueueMessage={handleQueueMessage}
        onUpdateQueuedMessage={updateQueuedMessages}
      />
    </div>
  );
}

const ChatUIMemo = memo(ChatUI);

// Dynamic export with SSR disabled to prevent UI from scrolling when an update comes in
export default dynamic(() => Promise.resolve(ChatUIMemo), {
  ssr: false,
});
