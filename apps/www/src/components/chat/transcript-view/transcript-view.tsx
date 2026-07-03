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
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai/conversation";
import type { AgUiReplayCursor } from "@/hooks/use-ag-ui-transport";
import { useDelayedFlag } from "@/hooks/use-delayed-flag";
import type { AgUiHistoryMessagesResult } from "@/lib/ag-ui-history-types";
import { cn } from "@/lib/utils";
import { respondToPermission } from "@/server-actions/respond-to-permission";
import { ChatError, isSandboxErrorType } from "../chat-error";
import { MessageScheduled, WorkingMessage } from "../chat-messages";
import { LeafLoading } from "../leaf-loading";
import type { ThreadMetaSnapshot } from "../meta-chips/use-thread-meta-events";
import { TerragonSystemMessage } from "../assistant-ui/system-message";
import {
  getWorkingFooterFreshness,
  getWorkingMessageSlotClassName,
  shouldSuppressPreStartLifecycleFooter,
} from "../assistant-ui/working-footer-freshness";
import { TranscriptItems } from "./transcript-items";
import {
  type PermissionDecision,
  TranscriptViewContextProvider,
} from "./transcript-view-context";
import {
  type TranscriptAppendRejection,
  useLiveTranscript,
} from "./use-live-transcript";
import { useStoreThreadFlags } from "./store-thread-flags";

export type TranscriptViewProps = {
  agent: AbstractAgent | null;
  loadAgUiHistoryMessages: () => Promise<AgUiHistoryMessagesResult>;
  setReplayCursor: (cursor: AgUiReplayCursor | null) => void;
  onAppendRejected?: (rejection: TranscriptAppendRejection) => void;
  lifecycleMessages: UISystemMessage[];
  threadStatus: ThreadStatus | null;
  isAgentWorking: boolean;
  thread: ThreadInfoFull;
  latestGitDiffTimestamp: string | null;
  artifactDescriptors: ArtifactDescriptor[];
  onOpenArtifact: (artifactId: string) => void;
  onOpenRepoFile?: (href: string) => void;
  /** Caller-supplied error (transient banner or persisted thread-chat error). */
  callerError?: string | null;
  /** Persisted thread-chat error type, if any. */
  callerErrorType?: string;
  /** Server-side retry mutation, used when the error is not transport-derived. */
  serverRetry: () => Promise<void>;
  isServerRetrying: boolean;
  isReadOnly?: boolean;
  chatAgent: AIAgent;
  bootingSubstatus?: BootingSubstatus;
  metaSnapshot: ThreadMetaSnapshot;
  reattemptQueueAt: Date | null;
  threadChatUpdatedAt?: Date | string | null;
  threadId: string;
  threadChatId?: string;
  scheduleAt?: Date | null;
  threadChatStatus?: ThreadStatus;
};

const SCROLL_BUTTON_CLASS = cn(
  "absolute bottom-5 left-1/2 -translate-x-1/2 z-10",
  "flex size-10 items-center justify-center rounded-full",
  "bg-card border border-border/60 shadow-md",
  "transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-emphasis)]",
  "active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  "data-[at-bottom=true]:opacity-0 data-[at-bottom=true]:translate-y-2 data-[at-bottom=true]:pointer-events-none",
);

export function TranscriptView({
  agent,
  loadAgUiHistoryMessages,
  setReplayCursor,
  onAppendRejected,
  lifecycleMessages,
  threadStatus,
  isAgentWorking,
  thread,
  latestGitDiffTimestamp,
  artifactDescriptors,
  onOpenArtifact,
  onOpenRepoFile,
  callerError,
  callerErrorType,
  serverRetry,
  isServerRetrying,
  isReadOnly,
  chatAgent,
  bootingSubstatus,
  metaSnapshot,
  reattemptQueueAt,
  threadChatUpdatedAt,
  threadId,
  threadChatId,
  scheduleAt,
  threadChatStatus,
}: TranscriptViewProps) {
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
    }),
    [isReadOnly, respond, onOpenRepoFile],
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
    <TranscriptViewContextProvider value={contextValue}>
      <div className="relative flex-1 overflow-hidden">
        <Conversation className="size-full">
          <ConversationContent>
            <div className="nauval-chat-surface flex flex-col flex-1 gap-6 w-full max-w-chat mx-auto px-4 sm:px-6 py-6 sm:py-8 mt-6 sm:mt-8 mb-8 rounded-[var(--radius-outer)]">
              {lifecycleMessages.length > 0 ? (
                <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-1 duration-[var(--duration-base)] ease-[var(--ease-emphasis)] motion-reduce:animate-none">
                  {lifecycleMessages.map((message, index) => (
                    <TerragonSystemMessage
                      key={`lifecycle-${message.id}`}
                      message={message}
                      messageIndex={index}
                      thread={thread}
                      latestGitDiffTimestamp={latestGitDiffTimestamp}
                      artifactDescriptors={artifactDescriptors}
                      onOpenArtifact={onOpenArtifact}
                      onOpenRepoFile={onOpenRepoFile}
                    />
                  ))}
                </div>
              ) : null}
              {isHydrating && showHydrationIndicator ? (
                <div className="pt-2 animate-in fade-in duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] motion-reduce:animate-none">
                  <LeafLoading message="Connecting to live task…" />
                </div>
              ) : null}
              <div className="flex flex-col gap-4">
                <TranscriptItems store={store} />
              </div>
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
          <ConversationScrollButton
            className={SCROLL_BUTTON_CLASS}
            aria-label="Scroll to bottom"
          >
            <ArrowDown className="size-4 text-muted-foreground" />
          </ConversationScrollButton>
        </Conversation>
      </div>
    </TranscriptViewContextProvider>
  );
}
