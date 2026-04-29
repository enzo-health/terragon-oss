"use client";

import { MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import type { BootingSubstatus } from "@terragon/sandbox/types";
import type {
  ThreadStatus,
  UIMessage,
  UISystemMessage,
} from "@terragon/shared";
import { ChatError } from "../chat-error";
import { MessageScheduled, WorkingMessage } from "../chat-messages";
import type { ThreadMetaSnapshot } from "../meta-chips/use-thread-meta-events";
import { RuntimeTerragonMessage } from "./runtime-terragon-message";
import { TerragonSystemMessage } from "./system-message";
import { TerragonUserMessage } from "./user-message";

type TerragonTranscriptSurfaceProps = {
  lifecycleMessages: UISystemMessage[];
  isRuntimeHydrating: boolean;
  messages: UIMessage[];
  localMessages: UIMessage[];
  runtimeMessageProjectionById: Map<
    string,
    { message: UIMessage; index: number }
  >;
  latestAgentMessageIndex: number;
  chatAgent: AIAgent;
  error?: string | null;
  errorType?: string;
  errorInfo?: string;
  handleRetry?: () => Promise<void>;
  isRetrying?: boolean;
  isReadOnly?: boolean;
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
  localMessages = [],
  runtimeMessageProjectionById,
  latestAgentMessageIndex,
  chatAgent,
  error,
  errorType,
  errorInfo,
  handleRetry,
  isRetrying,
  isReadOnly,
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

  return (
    <div className="flex flex-col flex-1 gap-6 w-full max-w-chat mx-auto px-4 sm:px-6 mt-12 mb-8">
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
        <div
          role="status"
          aria-live="polite"
          className="text-sm text-muted-foreground"
        >
          Loading task history...
        </div>
      ) : messages.length > 0 ? (
        <ThreadPrimitive.Messages>
          {({ message }) => {
            const projected = runtimeMessageProjectionById.get(message.id);
            if (!projected) return null;
            return (
              <MessagePrimitive.Root
                key={projected.message.id}
                className="contents"
              >
                <RuntimeTerragonMessage
                  message={projected.message}
                  messageIndex={projected.index}
                  isLatestMessage={projected.index === lastIndex}
                  isFirstUserMessage={projected.index === 0}
                  isLatestAgentMessage={
                    projected.index === latestAgentMessageIndex
                  }
                  agent={chatAgent}
                />
              </MessagePrimitive.Root>
            );
          }}
        </ThreadPrimitive.Messages>
      ) : null}
      {!isRuntimeHydrating
        ? localMessages.map((message) => {
            const projectedIndex = messages.findIndex(
              (candidate) => candidate.id === message.id,
            );
            const messageIndex =
              projectedIndex >= 0 ? projectedIndex : messages.length - 1;
            if (message.role === "user") {
              return (
                <TerragonUserMessage
                  key={message.id}
                  message={message}
                  messageIndex={messageIndex}
                  isLatestMessage={messageIndex === lastIndex}
                  isFirstUserMessage={messageIndex === 0}
                />
              );
            }
            if (message.role === "system") {
              return (
                <TerragonSystemMessage
                  key={message.id}
                  message={message}
                  messageIndex={messageIndex}
                  isLatestMessage={messageIndex === lastIndex}
                />
              );
            }
            return null;
          })
        : null}
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
      {showWorkingMessage && (
        <WorkingMessage
          agent={chatAgent}
          status={threadStatus ?? "working"}
          bootingSubstatus={bootingSubstatus}
          reattemptQueueAt={reattemptQueueAt}
          metaSnapshot={metaSnapshot}
          passiveWait={passiveWait}
        />
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
