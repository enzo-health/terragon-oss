"use client";

import { memo, useRef } from "react";
import type { AIAgent } from "@terragon/agent/types";
import type { BootingSubstatus } from "@terragon/sandbox/types";
import type {
  ThreadStatus,
  UIMessage,
  UISystemMessage,
} from "@terragon/shared";
import { ChatError } from "../chat-error";
import { LeafLoading } from "../leaf-loading";
import { MessageScheduled, WorkingMessage } from "../chat-messages";
import type { ThreadMetaSnapshot } from "../meta-chips/use-thread-meta-events";
import { RuntimeTerragonMessage } from "./runtime-terragon-message";
import { TerragonSystemMessage } from "./system-message";
import { TerragonUserMessage } from "./user-message";

type TerragonTranscriptSurfaceProps = {
  lifecycleMessages: UISystemMessage[];
  isRuntimeHydrating: boolean;
  messages: UIMessage[];
  latestAgentMessageIndex: number;
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
  messages,
  latestAgentMessageIndex,
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
  const lastIndex = messages.length - 1;
  const staticMessages = useStableMessagePrefix(
    messages,
    Math.max(0, lastIndex),
  );
  const liveMessage = lastIndex >= 0 ? messages[lastIndex] : undefined;
  const hasTranscriptMessages = messages.length > 0;
  const shouldRenderWorkingMessageSlot =
    reserveWorkingMessageSlot &&
    (!hasTranscriptMessages || showWorkingMessage || passiveWait);
  const workingMessageSlotClassName = getWorkingMessageSlotClassName({
    hasTranscriptMessages,
    threadStatus,
  });

  return (
    <div className="flex flex-col flex-1 gap-6 w-full max-w-chat mx-auto px-4 sm:px-6 mt-6 sm:mt-8 mb-8">
      {lifecycleMessages.length > 0 ? (
        <div className="flex flex-col gap-3">
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
        <div className="pt-2">
          <LeafLoading message="Connecting to live task…" />
        </div>
      ) : messages.length > 0 ? (
        <>
          <StaticTranscriptHistory
            messages={staticMessages}
            latestAgentMessageIndex={latestAgentMessageIndex}
          />
          {liveMessage ? (
            <TranscriptMessageRow
              message={liveMessage}
              messageIndex={lastIndex}
              isLatestMessage={true}
              isLatestAgentMessage={lastIndex === latestAgentMessageIndex}
            />
          ) : null}
        </>
      ) : null}
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
      {shouldRenderWorkingMessageSlot && (
        <div className={workingMessageSlotClassName}>
          {showWorkingMessage ? (
            <WorkingMessage
              agent={chatAgent}
              status={threadStatus ?? "working"}
              bootingSubstatus={bootingSubstatus}
              reattemptQueueAt={reattemptQueueAt}
              metaSnapshot={metaSnapshot}
              passiveWait={passiveWait}
            />
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

type TranscriptMessageRowProps = {
  message: UIMessage;
  messageIndex: number;
  isLatestMessage: boolean;
  isLatestAgentMessage: boolean;
};

const TranscriptMessageRow = memo(function TranscriptMessageRow({
  message,
  messageIndex,
  isLatestMessage,
  isLatestAgentMessage,
}: TranscriptMessageRowProps) {
  if (message.role === "user") {
    return (
      <TerragonUserMessage
        message={message}
        messageIndex={messageIndex}
        isLatestMessage={isLatestMessage}
        isFirstUserMessage={messageIndex === 0}
      />
    );
  }
  if (message.role === "system") {
    return (
      <TerragonSystemMessage
        message={message}
        messageIndex={messageIndex}
        isLatestMessage={isLatestMessage}
      />
    );
  }
  return (
    <RuntimeTerragonMessage
      message={message}
      messageIndex={messageIndex}
      isLatestMessage={isLatestMessage}
      isFirstUserMessage={false}
      isLatestAgentMessage={isLatestAgentMessage}
    />
  );
});

const StaticTranscriptHistory = memo(function StaticTranscriptHistory({
  messages,
  latestAgentMessageIndex,
}: {
  messages: UIMessage[];
  latestAgentMessageIndex: number;
}) {
  return (
    <>
      {messages.map((message, messageIndex) => (
        <TranscriptMessageRow
          key={message.id}
          message={message}
          messageIndex={messageIndex}
          isLatestMessage={false}
          isLatestAgentMessage={messageIndex === latestAgentMessageIndex}
        />
      ))}
    </>
  );
});

export function getWorkingMessageSlotClassName({
  hasTranscriptMessages,
  threadStatus,
}: {
  hasTranscriptMessages: boolean;
  threadStatus: ThreadStatus | null;
}): string {
  return threadStatus === "booting" && !hasTranscriptMessages
    ? "min-h-[168px]"
    : "min-h-11";
}

function useStableMessagePrefix(
  messages: UIMessage[],
  endExclusive: number,
): UIMessage[] {
  const previousRef = useRef<{
    endExclusive: number;
    prefix: UIMessage[];
  } | null>(null);
  const previous = previousRef.current;

  if (
    previous &&
    previous.endExclusive === endExclusive &&
    messages.length >= endExclusive &&
    previous.prefix.every((message, index) => messages[index] === message)
  ) {
    return previous.prefix;
  }

  const prefix = messages.slice(0, endExclusive);
  previousRef.current = { endExclusive, prefix };
  return prefix;
}
