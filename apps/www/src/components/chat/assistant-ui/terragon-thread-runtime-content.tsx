"use client";

import type { AIAgent } from "@terragon/agent/types";
import type { BootingSubstatus } from "@terragon/sandbox/types";
import type {
  ThreadInfoFull,
  ThreadStatus,
  UIUserMessage,
  UISystemMessage,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { createArtifactDescriptorLookup } from "../secondary-panel-helpers";
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
import { TerragonTranscriptSurface } from "./terragon-transcript-surface";
import {
  type TerragonMessageRenderContext,
  TerragonMessageRenderProvider,
  type TerragonThreadContext,
  TerragonThreadProvider,
} from "./thread-context";
import {
  getWorkingFooterFreshness,
  shouldSuppressPreStartLifecycleFooter,
} from "./working-footer-freshness";
import { useTerragonTranscript } from "./use-terragon-transcript";

export type TerragonThreadRuntimeContentProps = {
  lifecycleMessages: UISystemMessage[];
  threadStatus: ThreadStatus | null;
  thread: ThreadInfoFull;
  latestGitDiffTimestamp: string | null;
  isAgentWorking: boolean;
  artifactDescriptors: ArtifactDescriptor[];
  onOpenArtifact: (artifactId: string) => void;
  onOpenRepoFile?: (href: string) => void;
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
  onOpenRepoFile,
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
  const transcript = useTerragonTranscript({
    chatAgent,
    optimisticUserMessages,
  });
  const messages = transcript.messages;
  toolProps.messagesRef.current = messages;
  useScrollToHashMessageOnce({
    messages: transcript.isRuntimeHydrating ? [] : messages,
    resetKey: thread.id,
  });
  const planOccurrences = useStableRef(
    transcript.planOccurrencesRaw,
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
      hasAgentMessages: transcript.hasRenderableAgentParts,
    },
  );
  const baseShowWorking =
    isAgentWorking &&
    (!transcript.hasPendingToolCall || !transcript.hasRenderableAgentParts) &&
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
      onOpenRepoFile,
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
      onOpenRepoFile,
      planOccurrences,
      redoDialogData,
      forkDialogData,
      toolProps,
      hasCheckpoint,
      messagePartProps,
    ],
  );

  const messageRenderCtx = useMemo<TerragonMessageRenderContext>(
    () => ({
      isAgentWorking,
      artifactDescriptors: stableArtifactDescriptors,
      artifactDescriptorLookup,
      onOpenArtifact,
      onOpenRepoFile,
      planOccurrences,
      redoDialogData,
      forkDialogData,
      messagePartProps,
    }),
    [
      isAgentWorking,
      stableArtifactDescriptors,
      artifactDescriptorLookup,
      onOpenArtifact,
      onOpenRepoFile,
      planOccurrences,
      redoDialogData,
      forkDialogData,
      messagePartProps,
    ],
  );

  return (
    <TerragonThreadProvider value={ctx}>
      <TerragonMessageRenderProvider value={messageRenderCtx}>
        <TerragonTranscriptSurface
          lifecycleMessages={lifecycleMessages}
          isRuntimeHydrating={transcript.isRuntimeHydrating}
          messages={messages}
          latestAgentMessageIndex={transcript.latestAgentMessageIndex}
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
      </TerragonMessageRenderProvider>
      {children}
    </TerragonThreadProvider>
  );
}
