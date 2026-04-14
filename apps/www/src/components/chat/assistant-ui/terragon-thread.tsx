"use client";

import { useMemo } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { ThreadInfoFull, UIMessage, ThreadStatus } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import type { RedoDialogData, ForkDialogData } from "../chat-message.types";
import { useTerragonRuntime } from "../assistant-runtime";
import {
  TerragonThreadProvider,
  type TerragonThreadContext,
} from "./thread-context";
import { TerragonUserMessage } from "./user-message";
import { TerragonAssistantMessage } from "./assistant-message";
import { TerragonSystemMessage } from "./system-message";
import { ChatError } from "../chat-error";
import { WorkingMessage, MessageScheduled } from "../chat-messages";
import { isQueuedStatus } from "@/agent/thread-status";
import type { AIAgent } from "@terragon/agent/types";
import type { BootingSubstatus } from "@terragon/sandbox/types";
import { buildThreadPlanOccurrenceMap } from "./plan-occurrences";

type TerragonThreadProps = {
  messages: UIMessage[];
  threadStatus: ThreadStatus | null;
  thread: ThreadInfoFull;
  latestGitDiffTimestamp: string | null;
  isAgentWorking: boolean;
  artifactDescriptors: ArtifactDescriptor[];
  onOpenArtifact: (artifactId: string) => void;
  onNew: (text: string) => Promise<void>;
  onCancel?: () => Promise<void>;
  redoDialogData?: RedoDialogData;
  forkDialogData?: ForkDialogData;
  toolProps: TerragonThreadContext["toolProps"];
  hasCheckpoint: boolean;
  // Error display
  error?: string | null;
  errorType?: string;
  errorInfo?: string;
  handleRetry?: () => Promise<void>;
  isRetrying?: boolean;
  isReadOnly?: boolean | undefined;
  // Working message
  chatAgent: AIAgent;
  bootingSubstatus?: BootingSubstatus;
  reattemptQueueAt: Date | null;
  // Scheduled
  threadChatId?: string;
  scheduleAt?: Date | null;
  threadChatStatus?: ThreadStatus;
  // Children (prompt box, rendered below the messages)
  children?: React.ReactNode;
};

export function TerragonThread({
  messages,
  threadStatus,
  thread,
  latestGitDiffTimestamp,
  isAgentWorking,
  artifactDescriptors,
  onOpenArtifact,
  onNew,
  onCancel,
  redoDialogData,
  forkDialogData,
  toolProps,
  hasCheckpoint,
  error,
  errorType,
  errorInfo,
  handleRetry,
  isRetrying,
  isReadOnly,
  chatAgent,
  bootingSubstatus,
  reattemptQueueAt,
  threadChatId,
  scheduleAt,
  threadChatStatus,
  children,
}: TerragonThreadProps) {
  const runtime = useTerragonRuntime({
    messages,
    threadStatus,
    onNew,
    onCancel,
  });

  const planOccurrences = useMemo(
    () => buildThreadPlanOccurrenceMap(messages),
    [messages],
  );

  const latestAgentMessageIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "agent") return i;
    }
    return -1;
  }, [messages]);

  const hasAgentMessages = latestAgentMessageIndex >= 0;

  // Hide the "Waiting to start" indicator when the agent has already produced
  // messages — the status DB field may still be "queued" while the agent is
  // actively working due to broadcast-before-persist timing.
  const showWorkingMessage =
    isAgentWorking &&
    !(
      hasAgentMessages &&
      threadStatus !== null &&
      isQueuedStatus(threadStatus)
    );

  const ctx = useMemo<TerragonThreadContext>(
    () => ({
      messages,
      thread,
      latestGitDiffTimestamp,
      isAgentWorking,
      latestAgentMessageIndex,
      artifactDescriptors,
      onOpenArtifact,
      planOccurrences,
      redoDialogData,
      forkDialogData,
      toolProps,
      githubRepoFullName: thread.githubRepoFullName,
      branchName: thread.branchName,
      baseBranchName: thread.repoBaseBranchName,
      hasCheckpoint,
    }),
    [
      messages,
      thread,
      latestGitDiffTimestamp,
      isAgentWorking,
      latestAgentMessageIndex,
      artifactDescriptors,
      onOpenArtifact,
      planOccurrences,
      redoDialogData,
      forkDialogData,
      toolProps,
      hasCheckpoint,
    ],
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TerragonThreadProvider value={ctx}>
        <div className="flex flex-col flex-1 gap-6 w-full max-w-chat mx-auto px-6 mt-12 mb-4">
          {messages.map((message, index) => {
            switch (message.role) {
              case "user":
                return (
                  <TerragonUserMessage
                    key={message.id}
                    message={message}
                    messageIndex={index}
                  />
                );
              case "agent":
                return (
                  <TerragonAssistantMessage
                    key={message.id}
                    message={message}
                    messageIndex={index}
                  />
                );
              case "system":
                return (
                  <TerragonSystemMessage
                    key={message.id}
                    message={message}
                    messageIndex={index}
                  />
                );
              default:
                return null;
            }
          })}
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
            />
          )}
          {threadChatStatus === "scheduled" && scheduleAt && threadChatId && (
            <MessageScheduled
              threadId={thread.id}
              threadChatId={threadChatId}
              scheduleAt={scheduleAt}
            />
          )}
        </div>
        {children}
      </TerragonThreadProvider>
    </AssistantRuntimeProvider>
  );
}
