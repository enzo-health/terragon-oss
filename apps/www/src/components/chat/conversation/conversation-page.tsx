"use client";

import type { AbstractAgent } from "@ag-ui/client";
import type { AIAgent } from "@terragon/agent/types";
import type { BootingSubstatus } from "@terragon/sandbox/types";
import type {
  ThreadInfoFull,
  ThreadStatus,
  UISystemMessage,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { ArrowDown } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type RefObject,
} from "react";
import { Button } from "@/components/ai/button";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai/conversation";
import type { AgUiReplayCursor } from "@/hooks/use-ag-ui-transport";
import { useDelayedFlag } from "@/hooks/use-delayed-flag";
import type { AgUiHistoryMessagesResult } from "@/lib/ag-ui-history-types";
import { respondToPermission } from "@/server-actions/respond-to-permission";
import { ChatError, isSandboxErrorType } from "./chrome/chat-error";
import { MessageScheduled, WorkingMessage } from "./chrome/working-message";
import { Loader } from "@/components/ai/loader";
import type { ThreadMetaSnapshot } from "../meta-chips/use-thread-meta-events";
import { TerragonSystemMessage } from "./chrome/lifecycle-message";
import {
  getWorkingFooterFreshness,
  getWorkingMessageSlotClassName,
  shouldSuppressPreStartLifecycleFooter,
} from "./chrome/working-footer-freshness";
import { TranscriptItems } from "./transcript-items";
import { ScrollBridge, type ScrollController } from "./scroll-bridge";
import {
  type PermissionDecision,
  ConversationContextProvider,
} from "./conversation-context";
import {
  type TranscriptAppendRejection,
  useLiveTranscript,
} from "../transcript-data/use-live-transcript";
import { useStoreThreadFlags } from "../transcript-data/store-thread-flags";

export type ConversationPageTransport = {
  agent: AbstractAgent | null;
  loadAgUiHistoryMessages: () => Promise<AgUiHistoryMessagesResult>;
  setReplayCursor: (cursor: AgUiReplayCursor | null) => void;
  onAppendRejected?: (rejection: TranscriptAppendRejection) => void;
};

export type ConversationPageRun = {
  threadId: string;
  threadChatId?: string;
  thread: ThreadInfoFull;
  chatAgent: AIAgent;
  threadStatus: ThreadStatus | null;
  threadChatStatus?: ThreadStatus;
  isAgentWorking: boolean;
  bootingSubstatus?: BootingSubstatus;
  scheduleAt?: Date | null;
  reattemptQueueAt: Date | null;
  threadChatUpdatedAt?: Date | string | null;
  metaSnapshot: ThreadMetaSnapshot;
};

export type ConversationPageErrors = {
  callerError?: string | null;
  callerErrorType?: string;
  serverRetry: () => Promise<void>;
  isServerRetrying: boolean;
};

export type ConversationPageLifecycle = {
  messages: UISystemMessage[];
  latestGitDiffTimestamp: string | null;
};

export type ConversationPageProps = {
  transport: ConversationPageTransport;
  run: ConversationPageRun;
  errors: ConversationPageErrors;
  lifecycle: ConversationPageLifecycle;
  scrollController: RefObject<ScrollController | null>;
  isReadOnly?: boolean;
  onOpenArtifact: (artifactId: string) => void;
  onOpenRepoFile?: (href: string) => void;
  artifactDescriptors: ArtifactDescriptor[];
};

export function ConversationPage({
  transport,
  run,
  errors,
  lifecycle,
  scrollController,
  isReadOnly,
  onOpenArtifact,
  onOpenRepoFile,
  artifactDescriptors,
}: ConversationPageProps) {
  const { agent, loadAgUiHistoryMessages, setReplayCursor, onAppendRejected } =
    transport;
  const {
    threadId,
    threadChatId,
    thread,
    chatAgent,
    threadStatus,
    threadChatStatus,
    isAgentWorking,
    bootingSubstatus,
    scheduleAt,
    reattemptQueueAt,
    threadChatUpdatedAt,
    metaSnapshot,
  } = run;
  const { callerError, callerErrorType, serverRetry, isServerRetrying } =
    errors;
  const { messages: lifecycleMessages, latestGitDiffTimestamp } = lifecycle;

  const { store, isHydrating, errorType, errorInfo, handleRetry, isRetrying } =
    useLiveTranscript({
      agent,
      loadHistory: loadAgUiHistoryMessages,
      isAgentWorking,
      setReplayCursor,
      onAppendRejected,
      callerError,
      callerErrorType,
      callerErrorInfo: callerError ?? undefined,
      serverRetry,
      isServerRetrying,
    });
  const { hasRenderableAgentParts, hasPendingToolCall } =
    useStoreThreadFlags(store);
  const showHydrationIndicator = useDelayedFlag(isHydrating, 250);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isAgentWorking) return;
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [isAgentWorking]);

  const respond = useCallback(
    (permissionRequestId: string, optionId: PermissionDecision) => {
      if (!threadChatId) return;
      void respondToPermission({
        threadId,
        threadChatId,
        promptId: permissionRequestId,
        optionId,
      });
    },
    [threadId, threadChatId],
  );

  const contextValue = useMemo(
    () => ({
      isReadOnly: isReadOnly ?? false,
      respondToPermission: respond,
      onOpenRepoFile,
      onOpenArtifact,
      artifactDescriptors,
    }),
    [isReadOnly, respond, onOpenRepoFile, onOpenArtifact, artifactDescriptors],
  );

  const hasSandboxError = isSandboxErrorType(errorType ?? null);
  const suppressPreStartLifecycleFooter = shouldSuppressPreStartLifecycleFooter(
    { threadStatus, hasAgentMessages: hasRenderableAgentParts },
  );
  const baseShowWorking =
    isAgentWorking &&
    (!hasPendingToolCall || !hasRenderableAgentParts) &&
    !hasSandboxError &&
    !suppressPreStartLifecycleFooter;
  const shouldCheckWorkingFooterFreshness =
    isAgentWorking && !hasSandboxError && !suppressPreStartLifecycleFooter;

  const footerFreshness = useMemo(
    () =>
      getWorkingFooterFreshness({
        now: new Date(nowMs),
        isWorkingCandidate: shouldCheckWorkingFooterFreshness,
        threadChatUpdatedAt: threadChatUpdatedAt ?? null,
        uncertainMessage: "Waiting for updates",
      }),
    [nowMs, shouldCheckWorkingFooterFreshness, threadChatUpdatedAt],
  );
  const passiveWait =
    footerFreshness.kind === "uncertain"
      ? { message: footerFreshness.message, reason: null }
      : null;

  const reserveWorkingMessageSlot = isAgentWorking && !hasSandboxError;
  const shouldRenderWorkingMessage = baseShowWorking || passiveWait !== null;

  return (
    <ConversationContextProvider value={contextValue}>
      <div className="relative flex-1 overflow-hidden">
        <Conversation className="size-full">
          <ConversationContent className="pt-10 pb-12 px-2.5">
            <div className="nauval-chat-surface mx-auto flex w-full max-w-chat flex-col gap-6 px-4 sm:px-6">
              {lifecycleMessages.length > 0 ? (
                <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-1 duration-[var(--duration-base)] ease-[var(--ease-emphasis)] motion-reduce:animate-none">
                  {lifecycleMessages.map((message, index) => (
                    <TerragonSystemMessage
                      key={`lifecycle-${message.id}`}
                      message={message}
                      messageIndex={index}
                      thread={thread}
                      latestGitDiffTimestamp={latestGitDiffTimestamp}
                    />
                  ))}
                </div>
              ) : null}
              {isHydrating && showHydrationIndicator ? (
                <div className="pt-2 animate-in fade-in duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] motion-reduce:animate-none">
                  <Loader variant="shimmer" dots className="text-sm">
                    Connecting to live task…
                  </Loader>
                </div>
              ) : null}
              <TranscriptItems store={store} />
              {errorType || errorInfo ? (
                <ChatError
                  status={threadStatus ?? "error"}
                  errorType={errorType || ""}
                  errorInfo={errorInfo || "An unknown error occurred"}
                  handleRetry={handleRetry ?? (async () => {})}
                  isReadOnly={isReadOnly ?? false}
                  isRetrying={isRetrying}
                />
              ) : null}
              {reserveWorkingMessageSlot ? (
                <div
                  className={getWorkingMessageSlotClassName({ threadStatus })}
                >
                  {shouldRenderWorkingMessage ? (
                    <div className="animate-in fade-in duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] motion-reduce:animate-none">
                      <WorkingMessage
                        agent={chatAgent}
                        status={threadStatus ?? "working"}
                        bootingSubstatus={bootingSubstatus}
                        reattemptQueueAt={reattemptQueueAt}
                        metaSnapshot={metaSnapshot}
                        passiveWait={passiveWait}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
              {threadChatStatus === "scheduled" &&
              scheduleAt &&
              threadChatId ? (
                <MessageScheduled
                  threadId={threadId}
                  threadChatId={threadChatId}
                  scheduleAt={scheduleAt}
                />
              ) : null}
            </div>
          </ConversationContent>
          <ScrollBridge controller={scrollController} />
          <ConversationScrollButton
            render={
              <Button
                iconOnly
                variant="outline"
                className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 size-9 rounded-full bg-surface-elevated shadow-md transition-all data-[at-bottom=true]:pointer-events-none data-[at-bottom=true]:translate-y-1 data-[at-bottom=true]:opacity-0"
                aria-label="Scroll to bottom"
              />
            }
          >
            <ArrowDown className="size-4" />
          </ConversationScrollButton>
        </Conversation>
      </div>
    </ConversationContextProvider>
  );
}
