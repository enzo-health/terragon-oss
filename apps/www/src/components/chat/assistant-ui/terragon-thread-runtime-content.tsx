"use client";

import {
  useAuiState,
  type ThreadAssistantMessagePart,
  type ThreadMessage,
} from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import type { BootingSubstatus } from "@terragon/sandbox/types";
import type {
  ThreadInfoFull,
  ThreadStatus,
  UISystemMessage,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { createArtifactDescriptorLookup } from "../secondary-panel-helpers";
import { useEffect, useMemo, useState } from "react";
import { useStableRef } from "@/hooks/use-stable-ref";
import { isSandboxErrorType } from "../chat-error";
import { useScrollToHashMessageOnce } from "../use-chat-effects";
import type { ForkDialogData, RedoDialogData } from "../dialog-data";
import type { ThreadMetaSnapshot } from "../meta-chips/use-thread-meta-events";
import { isEqualArtifactList, isEqualPlanMap } from "./ctx-stability";
import { TerragonTranscriptSurface } from "./terragon-transcript-surface";
import {
  type TerragonThreadContext,
  TerragonThreadProvider,
} from "./thread-context";
import {
  getWorkingFooterFreshness,
  shouldSuppressPreStartLifecycleFooter,
} from "./working-footer-freshness";

const RUNTIME_THREAD_FLAG_HAS_RENDERABLE_AGENT_PARTS = 1;
const RUNTIME_THREAD_FLAG_HAS_PENDING_TOOL_CALL = 2;

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
  children?: React.ReactNode;
};

function threadMessageHasRenderableParts(message: ThreadMessage): boolean {
  return message.content.some((part) => {
    switch (part.type) {
      case "text":
      case "reasoning":
        return part.text.trim().length > 0;
      case "tool-call":
        return true;
      default:
        return false;
    }
  });
}

function isPendingToolCall(part: ThreadAssistantMessagePart): boolean {
  return (
    part.type === "tool-call" && (!("result" in part) || part.result === null)
  );
}

function threadMessageHasPendingToolCall(message: ThreadMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  return message.content.some(isPendingToolCall);
}

export function getRuntimeThreadFlags(
  messages: readonly ThreadMessage[],
): number {
  let flags = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") {
      continue;
    }
    if (
      (flags & RUNTIME_THREAD_FLAG_HAS_RENDERABLE_AGENT_PARTS) === 0 &&
      threadMessageHasRenderableParts(message)
    ) {
      flags |= RUNTIME_THREAD_FLAG_HAS_RENDERABLE_AGENT_PARTS;
    }
    if (
      (flags & RUNTIME_THREAD_FLAG_HAS_PENDING_TOOL_CALL) === 0 &&
      threadMessageHasPendingToolCall(message)
    ) {
      flags |= RUNTIME_THREAD_FLAG_HAS_PENDING_TOOL_CALL;
    }
    if ((flags & RUNTIME_THREAD_FLAG_HAS_RENDERABLE_AGENT_PARTS) !== 0) {
      return flags;
    }
  }

  return flags;
}

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
  children,
}: TerragonThreadRuntimeContentProps) {
  const isRuntimeHydrating = useAuiState(
    (state) => state.thread.isLoading && state.thread.messages.length === 0,
  );
  const runtimeThreadFlags = useAuiState((state) =>
    getRuntimeThreadFlags(state.thread.messages),
  );
  const hasRenderableAgentParts =
    (runtimeThreadFlags & RUNTIME_THREAD_FLAG_HAS_RENDERABLE_AGENT_PARTS) !== 0;
  const hasPendingToolCall =
    (runtimeThreadFlags & RUNTIME_THREAD_FLAG_HAS_PENDING_TOOL_CALL) !== 0;
  useScrollToHashMessageOnce({
    messages: [],
    resetKey: thread.id,
  });
  const planOccurrences = useStableRef(new Map(), isEqualPlanMap);
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
      hasAgentMessages: hasRenderableAgentParts,
    },
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

  const passiveWaitProp =
    footerFreshness.kind === "uncertain"
      ? { message: footerFreshness.message, reason: null }
      : null;

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
    ],
  );

  return (
    <TerragonThreadProvider value={ctx}>
      <TerragonTranscriptSurface
        lifecycleMessages={lifecycleMessages}
        isRuntimeHydrating={isRuntimeHydrating}
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
