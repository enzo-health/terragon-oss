"use client";

import type { AIAgent } from "@terragon/agent/types";
import type { BootingSubstatus } from "@terragon/sandbox/types";
import type { ThreadStatus, UISystemMessage } from "@terragon/shared";
import { ChatError } from "../chat-error";
import { LeafLoading } from "../leaf-loading";
import { MessageScheduled, WorkingMessage } from "../chat-messages";
import type { ThreadMetaSnapshot } from "../meta-chips/use-thread-meta-events";
import { NativeThread } from "./native-thread";
import { TerragonSystemMessage } from "./system-message";

type TerragonTranscriptSurfaceProps = {
  lifecycleMessages: UISystemMessage[];
  isRuntimeHydrating: boolean;
  chatAgent: AIAgent;
  error?: string | null;
  errorType?: string;
  errorInfo?: string;
  handleRetry?: () => Promise<void>;
  isRetrying?: boolean;
  isReadOnly?: boolean;
  reserveWorkingMessageSlot: boolean;
  showWorkingMessage: boolean;
  threadStatus: ThreadStatus | null;
  bootingSubstatus?: BootingSubstatus;
  reattemptQueueAt: Date | null;
  metaSnapshot: ThreadMetaSnapshot;
  passiveWait: { message: string; reason: null } | null;
  threadId: string;
  threadChatId?: string;
  scheduleAt?: Date | null;
  threadChatStatus?: ThreadStatus;
};

export function TerragonTranscriptSurface({
  lifecycleMessages,
  isRuntimeHydrating,
  chatAgent,
  error,
  errorType,
  errorInfo,
  handleRetry,
  isRetrying,
  isReadOnly,
  reserveWorkingMessageSlot,
  showWorkingMessage,
  threadStatus,
  bootingSubstatus,
  reattemptQueueAt,
  metaSnapshot,
  passiveWait,
  threadId,
  threadChatId,
  scheduleAt,
  threadChatStatus,
}: TerragonTranscriptSurfaceProps) {
  const shouldRenderWorkingMessage = showWorkingMessage || passiveWait !== null;
  const workingMessageSlotClassName = getWorkingMessageSlotClassName({
    threadStatus,
  });

  return (
    <div className="flex flex-col flex-1 gap-6 w-full max-w-chat mx-auto px-4 sm:px-6 mt-6 sm:mt-8 mb-8">
      {lifecycleMessages.length > 0 ? (
        <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-1 duration-[var(--duration-base)] ease-[var(--ease-emphasis)]">
          {lifecycleMessages.map((message, index) => (
            <TerragonSystemMessage
              key={`lifecycle-${message.id}`}
              message={message}
              messageIndex={index}
              isLatestMessage={index === lifecycleMessages.length - 1}
            />
          ))}
        </div>
      ) : null}
      {isRuntimeHydrating ? (
        <div className="pt-2 animate-in fade-in duration-[var(--duration-quick)] ease-[var(--ease-emphasis)]">
          <LeafLoading message="Connecting to live task…" />
        </div>
      ) : (
        <div className="animate-in fade-in duration-[var(--duration-base)] ease-[var(--ease-emphasis)]">
          <NativeThread />
        </div>
      )}
      {(error || errorType || errorInfo) && (
        <ChatError
          status={threadStatus ?? "error"}
          errorType={errorType || ""}
          errorInfo={error || errorInfo || "An unknown error occurred"}
          handleRetry={handleRetry ?? (async () => {})}
          isReadOnly={isReadOnly ?? false}
          isRetrying={isRetrying}
        />
      )}
      {reserveWorkingMessageSlot && (
        <div className={workingMessageSlotClassName}>
          {shouldRenderWorkingMessage ? (
            <div className="animate-in fade-in duration-[var(--duration-quick)] ease-[var(--ease-emphasis)]">
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
      )}
      {threadChatStatus === "scheduled" && scheduleAt && threadChatId && (
        <MessageScheduled
          threadId={threadId}
          threadChatId={threadChatId}
          scheduleAt={scheduleAt}
        />
      )}
    </div>
  );
}

export function getWorkingMessageSlotClassName({
  threadStatus,
}: {
  threadStatus: ThreadStatus | null;
}): string {
  return threadStatus === "booting"
    ? "min-h-[168px]"
    : "min-h-11 flex items-start";
}
