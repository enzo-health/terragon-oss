"use client";

import { useAuiState } from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import type { BootingSubstatus } from "@terragon/sandbox/types";
import type {
  ThreadInfoFull,
  ThreadStatus,
  UIMessage,
  UIUserMessage,
  UISystemMessage,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { useEffect, useMemo, useState } from "react";
import { useStableRef } from "@/hooks/use-stable-ref";
import { isSandboxErrorType } from "../chat-error";
import { useScrollToHashMessageOnce } from "../use-chat-effects";
import type {
  ForkDialogData,
  MessagePartRenderProps,
  RedoDialogData,
} from "../chat-message.types";
import type { ThreadMetaSnapshot } from "../meta-chips/use-thread-meta-events";
import { isEqualArtifactList, isEqualPlanMap } from "./ctx-stability";
import { buildThreadPlanOccurrenceMap } from "./plan-occurrences";
import { projectRuntimeOwnedRows } from "./runtime-row-projection";
import { createRuntimeTranscriptProjector } from "./runtime-transcript-adapter";
import { TerragonTranscriptSurface } from "./terragon-transcript-surface";
import {
  type TerragonThreadContext,
  TerragonThreadProvider,
} from "./thread-context";
import {
  getWorkingFooterFreshness,
  shouldSuppressPreStartLifecycleFooter,
} from "./working-footer-freshness";

export type TerragonThreadRuntimeContentProps = {
  lifecycleMessages: UISystemMessage[];
  threadStatus: ThreadStatus | null;
  thread: ThreadInfoFull;
  latestGitDiffTimestamp: string | null;
  isAgentWorking: boolean;
  artifactDescriptors: ArtifactDescriptor[];
  onOpenArtifact: (artifactId: string) => void;
  onCancel?: () => Promise<void>;
  redoDialogData?: RedoDialogData;
  forkDialogData?: ForkDialogData;
  toolProps: TerragonThreadContext["toolProps"];
  hasCheckpoint: boolean;
  error?: string | null;
  errorType?: string;
  errorInfo?: string;
  handleRetry?: () => Promise<void>;
  isRetrying?: boolean;
  isReadOnly?: boolean | undefined;
  chatAgent: AIAgent;
  bootingSubstatus?: BootingSubstatus;
  metaSnapshot: ThreadMetaSnapshot;
  reattemptQueueAt: Date | null;
  threadChatUpdatedAt?: Date | string | null;
  threadChatId?: string;
  scheduleAt?: Date | null;
  threadChatStatus?: ThreadStatus;
  optimisticUserMessages?: UIUserMessage[];
  children?: React.ReactNode;
};

export function TerragonThreadRuntimeContent({
  lifecycleMessages,
  threadStatus,
  thread,
  latestGitDiffTimestamp,
  isAgentWorking,
  artifactDescriptors,
  onOpenArtifact,
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
  metaSnapshot,
  reattemptQueueAt,
  threadChatUpdatedAt,
  threadChatId,
  scheduleAt,
  threadChatStatus,
  optimisticUserMessages = [],
  children,
}: TerragonThreadRuntimeContentProps) {
  const runtimeMessages = useAuiState((state) => state.thread.messages);
  const runtimeIsLoading = useAuiState((state) => state.thread.isLoading);
  const runtimeTranscriptProjector = useMemo(
    () => createRuntimeTranscriptProjector(),
    [],
  );
  const projectedTranscript = useMemo(
    () =>
      runtimeTranscriptProjector({
        runtimeMessages,
        agent: chatAgent,
      }),
    [chatAgent, runtimeMessages, runtimeTranscriptProjector],
  );
  const transcriptProjection = useMemo(
    () =>
      projectRuntimeOwnedRows({
        runtimeMessages,
        projectedTranscript,
        agent: chatAgent,
      }),
    [chatAgent, projectedTranscript, runtimeMessages],
  );
  const messages = useMemo(
    () =>
      appendOptimisticUserMessages(
        transcriptProjection.messages,
        optimisticUserMessages,
      ),
    [optimisticUserMessages, transcriptProjection.messages],
  );
  toolProps.messagesRef.current = messages;
  const isRuntimeHydrating = runtimeIsLoading && runtimeMessages.length === 0;
  useScrollToHashMessageOnce({
    messages: isRuntimeHydrating ? [] : messages,
    resetKey: thread.id,
  });
  const runtimeMessageProjectionById = useMemo(() => {
    const lookup = new Map<string, { message: UIMessage; index: number }>();
    const runtimeMessageIds = new Set(
      runtimeMessages.map((message) => message.id),
    );
    messages.forEach((message, index) => {
      if (message.id && runtimeMessageIds.has(message.id)) {
        lookup.set(message.id, { message, index });
      }
    });
    return lookup;
  }, [messages, runtimeMessages]);
  const localTranscriptMessages = useMemo(() => {
    const runtimeMessageIds = new Set(
      runtimeMessages.map((message) => message.id),
    );
    return messages.filter((message) => !runtimeMessageIds.has(message.id));
  }, [messages, runtimeMessages]);

  const planOccurrencesRaw = useMemo(
    () => buildThreadPlanOccurrenceMap(messages),
    [messages],
  );
  const planOccurrences = useStableRef(planOccurrencesRaw, isEqualPlanMap);
  const stableArtifactDescriptors = useStableRef(
    artifactDescriptors,
    isEqualArtifactList,
  );

  const latestAgentMessageIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "agent") return i;
    }
    return -1;
  }, [messages]);

  const hasRenderableAgentParts = messages.some(
    (message) => message.role === "agent" && message.parts.length > 0,
  );

  const hasPendingToolCall = useMemo(() => {
    const latestRuntimeAgentMessage = [...runtimeMessages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (latestRuntimeAgentMessage) {
      return latestRuntimeAgentMessage.content.some(
        (part) => part.type === "tool-call" && part.result === undefined,
      );
    }
    if (latestAgentMessageIndex < 0) return false;
    const msg = messages[latestAgentMessageIndex];
    if (!msg || msg.role !== "agent") return false;
    for (const part of msg.parts) {
      if (part.type === "tool" && part.status === "pending") return true;
    }
    return false;
  }, [messages, latestAgentMessageIndex, runtimeMessages]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isAgentWorking) return;
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [isAgentWorking]);

  const hasSandboxError = isSandboxErrorType(errorType ?? null);
  const baseShowWorking =
    isAgentWorking &&
    (!hasPendingToolCall || !hasRenderableAgentParts) &&
    !hasSandboxError &&
    !shouldSuppressPreStartLifecycleFooter({
      threadStatus,
      hasAgentMessages: hasRenderableAgentParts,
    });

  const footerFreshness = useMemo(
    () =>
      getWorkingFooterFreshness({
        now: new Date(nowMs),
        isWorkingCandidate: baseShowWorking,
        threadChatUpdatedAt: threadChatUpdatedAt ?? null,
        uncertainMessage: "Waiting for updates",
      }),
    [baseShowWorking, nowMs, threadChatUpdatedAt],
  );

  const passiveWaitProp =
    footerFreshness.kind === "uncertain"
      ? { message: footerFreshness.message, reason: null }
      : null;

  const messagePartProps = useMemo<MessagePartRenderProps>(
    () => ({
      githubRepoFullName: thread.githubRepoFullName,
      branchName: thread.branchName,
      baseBranchName: thread.repoBaseBranchName,
      hasCheckpoint,
      toolProps,
    }),
    [
      thread.githubRepoFullName,
      thread.branchName,
      thread.repoBaseBranchName,
      hasCheckpoint,
      toolProps,
    ],
  );

  const ctx = useMemo<TerragonThreadContext>(
    () => ({
      thread,
      latestGitDiffTimestamp,
      isAgentWorking,
      artifactDescriptors: stableArtifactDescriptors,
      onOpenArtifact,
      planOccurrences,
      redoDialogData,
      forkDialogData,
      toolProps,
      githubRepoFullName: thread.githubRepoFullName,
      branchName: thread.branchName,
      baseBranchName: thread.repoBaseBranchName,
      hasCheckpoint,
      messagePartProps,
    }),
    [
      thread,
      latestGitDiffTimestamp,
      isAgentWorking,
      stableArtifactDescriptors,
      onOpenArtifact,
      planOccurrences,
      redoDialogData,
      forkDialogData,
      toolProps,
      hasCheckpoint,
      messagePartProps,
    ],
  );

  return (
    <TerragonThreadProvider value={ctx}>
      <TerragonTranscriptSurface
        lifecycleMessages={lifecycleMessages}
        isRuntimeHydrating={isRuntimeHydrating}
        messages={messages}
        localMessages={localTranscriptMessages}
        runtimeMessageProjectionById={runtimeMessageProjectionById}
        latestAgentMessageIndex={latestAgentMessageIndex}
        chatAgent={chatAgent}
        error={error}
        errorType={errorType}
        errorInfo={errorInfo}
        handleRetry={handleRetry}
        isRetrying={isRetrying}
        isReadOnly={isReadOnly}
        showWorkingMessage={baseShowWorking}
        threadStatus={threadStatus}
        bootingSubstatus={bootingSubstatus}
        reattemptQueueAt={reattemptQueueAt}
        metaSnapshot={metaSnapshot}
        passiveWait={passiveWaitProp}
        threadId={thread.id}
        threadChatId={threadChatId}
        scheduleAt={scheduleAt}
        threadChatStatus={threadChatStatus}
      />
      {children}
    </TerragonThreadProvider>
  );
}

function appendOptimisticUserMessages(
  messages: UIMessage[],
  optimisticUserMessages: UIUserMessage[],
): UIMessage[] {
  if (optimisticUserMessages.length === 0) {
    return messages;
  }

  let nextMessages: UIMessage[] | null = null;
  for (const optimisticMessage of optimisticUserMessages) {
    const existingMessages: UIMessage[] = nextMessages ?? messages;
    const duplicate = existingMessages.some((message) =>
      isSameUserMessage(message, optimisticMessage),
    );
    if (duplicate) {
      continue;
    }
    nextMessages = [...existingMessages, optimisticMessage];
  }

  return nextMessages ?? messages;
}

function isSameUserMessage(
  message: UIMessage,
  optimisticMessage: UIUserMessage,
): boolean {
  return (
    message.role === "user" &&
    message.parts.length === optimisticMessage.parts.length &&
    message.parts.every((part, index) =>
      isSameUserMessagePart(part, optimisticMessage.parts[index]),
    )
  );
}

function isSameUserMessagePart(
  part: UIUserMessage["parts"][number],
  optimisticPart: UIUserMessage["parts"][number] | undefined,
): boolean {
  return (
    optimisticPart !== undefined &&
    part.type === optimisticPart.type &&
    JSON.stringify(part) === JSON.stringify(optimisticPart)
  );
}
