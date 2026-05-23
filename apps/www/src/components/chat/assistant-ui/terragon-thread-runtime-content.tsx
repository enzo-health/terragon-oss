"use client";

import { useAuiState } from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import type { BootingSubstatus } from "@terragon/sandbox/types";
import type {
  ThreadInfoFull,
  ThreadStatus,
  UIUserMessage,
  UISystemMessage,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { createArtifactDescriptorLookup } from "../secondary-panel";
import { useEffect, useMemo, useState } from "react";
import { useStableRef } from "@/hooks/use-stable-ref";
import { isSandboxErrorType } from "../chat-error";
import { useScrollToHashMessageOnce } from "../use-chat-effects";
import type { TerragonRuntimeProjectionHintRef } from "../terragon-ag-ui-runtime-core";
import type {
  ForkDialogData,
  MessagePartRenderProps,
  RedoDialogData,
} from "../chat-message.types";
import type { ThreadMetaSnapshot } from "../meta-chips/use-thread-meta-events";
import { isEqualArtifactList, isEqualPlanMap } from "./ctx-stability";
import { createRuntimeTranscriptProjector } from "./runtime-transcript-adapter";
import { createTerragonTranscriptModelBuilder } from "./terragon-transcript-model";
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
  projectionHintRef?: TerragonRuntimeProjectionHintRef;
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
  projectionHintRef,
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
        projectionHint: projectionHintRef?.current,
      }),
    [
      chatAgent,
      projectionHintRef?.current,
      runtimeMessages,
      runtimeTranscriptProjector,
    ],
  );
  const transcriptModelBuilder = useMemo(
    () => createTerragonTranscriptModelBuilder(),
    [],
  );
  const transcriptModel = useMemo(
    () =>
      transcriptModelBuilder({
        runtimeMessages: projectedTranscript.messages,
        optimisticUserMessages,
      }),
    [
      optimisticUserMessages,
      projectedTranscript.messages,
      transcriptModelBuilder,
    ],
  );
  const messages = transcriptModel.messages;
  toolProps.messagesRef.current = messages;
  const isRuntimeHydrating =
    runtimeIsLoading && runtimeMessages.length === 0 && messages.length === 0;
  useScrollToHashMessageOnce({
    messages: isRuntimeHydrating ? [] : messages,
    resetKey: thread.id,
  });
  const planOccurrences = useStableRef(
    transcriptModel.planOccurrencesRaw,
    isEqualPlanMap,
  );
  const stableArtifactDescriptors = useStableRef(
    artifactDescriptors,
    isEqualArtifactList,
  );
  const artifactDescriptorLookup = useMemo(
    () => createArtifactDescriptorLookup(stableArtifactDescriptors),
    [stableArtifactDescriptors],
  );

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isAgentWorking) return;
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [isAgentWorking]);

  const hasSandboxError = isSandboxErrorType(errorType ?? null);
  const suppressPreStartLifecycleFooter = shouldSuppressPreStartLifecycleFooter(
    {
      threadStatus,
      hasAgentMessages: transcriptModel.hasRenderableAgentParts,
    },
  );
  const baseShowWorking =
    isAgentWorking &&
    (!transcriptModel.hasPendingToolCall ||
      !transcriptModel.hasRenderableAgentParts) &&
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
      artifactDescriptorLookup,
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
      artifactDescriptorLookup,
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
        latestAgentMessageIndex={transcriptModel.latestAgentMessageIndex}
        chatAgent={chatAgent}
        error={error}
        errorType={errorType}
        errorInfo={errorInfo}
        handleRetry={handleRetry}
        isRetrying={isRetrying}
        isReadOnly={isReadOnly}
        reserveWorkingMessageSlot={isAgentWorking && !hasSandboxError}
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
