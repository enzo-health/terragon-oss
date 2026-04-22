"use client";

import { useEffect, useMemo, useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { HttpAgent } from "@ag-ui/client";
import type { ThreadInfoFull, UIMessage, ThreadStatus } from "@terragon/shared";
import type { DeliveryLoopState } from "@terragon/shared/db/types";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import type {
  RedoDialogData,
  ForkDialogData,
  MessagePartRenderProps,
} from "../chat-message.types";
import { useTerragonRuntime } from "../assistant-runtime";
import {
  TerragonThreadProvider,
  type TerragonThreadContext,
} from "./thread-context";
import { TerragonUserMessage } from "./user-message";
import { TerragonAssistantMessage } from "./assistant-message";
import { TerragonSystemMessage } from "./system-message";
import { ChatError, isSandboxErrorType } from "../chat-error";
import {
  WorkingMessage,
  MessageScheduled,
  classifyDeliveryLoopFooter,
} from "../chat-messages";
import { isQueuedStatus } from "@/agent/thread-status";
import type { AIAgent } from "@terragon/agent/types";
import type { BootingSubstatus } from "@terragon/sandbox/types";
import { buildThreadPlanOccurrenceMap } from "./plan-occurrences";
import { useStableRef } from "@/hooks/use-stable-ref";
import { isEqualPlanMap, isEqualArtifactList } from "./ctx-stability";
import {
  getWorkingFooterFreshness,
  shouldUseDeliveryLoopHeadOverride,
} from "@/lib/delivery-loop-status";

type TerragonThreadProps = {
  /**
   * AG-UI transport agent powering the `AssistantRuntime`. Built by
   * `useAgUiTransport` in the parent and passed down.
   */
  agent: HttpAgent;
  /**
   * Rendered messages. Task 6B: these are projected from the AG-UI SSE
   * stream via `useAgUiMessages` (seeded with `toUIMessages(dbMessages)`)
   * in `chat-ui.tsx`. The AG-UI runtime itself powers the composer / run-
   * state but not the message list.
   */
  messages: UIMessage[];
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
  /**
   * Current delivery-loop state, used to override the "Assistant is
   * working" footer when the workflow is actually in a passive-wait
   * state (e.g. awaiting PR merge) so users aren't misled into thinking
   * the system is stuck. Null/undefined preserves the pre-existing
   * footer behavior for non-delivery-loop threads.
   */
  deliveryLoopState?: DeliveryLoopState | null;
  /** `delivery_workflow_head_v3.updatedAt` (durable) as an ISO string. */
  deliveryLoopUpdatedAtIso?: string | null;
  /** `thread_chat.updatedAt` (durable). */
  threadChatUpdatedAt?: Date | string | null;
  /**
   * Human-readable reason the loop is blocked (e.g. "PR closed", "CI gate
   * did not complete within polling budget"). Rendered as secondary text in
   * the passive-wait footer so users see the specific reason instead of a
   * generic "Waiting for your input" line. Null when no reason is
   * available.
   */
  deliveryLoopBlockedReason?: string | null;
  // Scheduled
  threadChatId?: string;
  scheduleAt?: Date | null;
  threadChatStatus?: ThreadStatus;
  // Children (prompt box, rendered below the messages)
  children?: React.ReactNode;
};

export function TerragonThread({
  agent,
  messages,
  threadStatus,
  thread,
  latestGitDiffTimestamp,
  isAgentWorking,
  artifactDescriptors,
  onOpenArtifact,
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
  deliveryLoopState,
  deliveryLoopUpdatedAtIso,
  threadChatUpdatedAt,
  deliveryLoopBlockedReason,
  threadChatId,
  scheduleAt,
  threadChatStatus,
  children,
}: TerragonThreadProps) {
  // Only agents that emit reasoning / thinking events benefit from the
  // thinking UI. Other agents would show an empty "thinking" affordance.
  const showThinking = chatAgent === "claudeCode" || chatAgent === "codex";

  const runtime = useTerragonRuntime({
    agent,
    showThinking,
    ...(onCancel && { onCancel }),
  });

  // Reference-stabilize plan occurrences and artifact descriptors. Both
  // reallocate on every `messages` change (i.e. every token delta) but
  // rarely change *semantically* during text streaming. We return the
  // prior reference whenever the content is equivalent, so downstream
  // memoized components (`ChatMessage`) skip re-renders.
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

  const hasAgentMessages = latestAgentMessageIndex >= 0;

  // True when the latest agent message has a tool call in flight. Used to
  // suppress the footer "Assistant is working" indicator, since the inline
  // tool chip ("Working...") on that tool part already conveys activity. We
  // only need to check the latest agent message: the reducer marks prior
  // tool parts as completed once a newer agent message or tool starts.
  const hasPendingToolCall = useMemo(() => {
    if (latestAgentMessageIndex < 0) return false;
    const msg = messages[latestAgentMessageIndex];
    if (!msg || msg.role !== "agent") return false;
    for (const part of msg.parts) {
      if (part.type === "tool" && part.status === "pending") return true;
    }
    return false;
  }, [messages, latestAgentMessageIndex]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const shouldTickFreshnessClock = isAgentWorking || deliveryLoopState !== null;
  useEffect(() => {
    if (!shouldTickFreshnessClock) return;
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [shouldTickFreshnessClock]);

  const canApplyDeliveryLoopFooterOverride = useMemo(
    () =>
      shouldUseDeliveryLoopHeadOverride({
        now: new Date(nowMs),
        deliveryLoopUpdatedAtIso: deliveryLoopUpdatedAtIso ?? null,
        threadChatUpdatedAt: threadChatUpdatedAt ?? null,
      }),
    [deliveryLoopUpdatedAtIso, nowMs, threadChatUpdatedAt],
  );

  // Classify the delivery-loop state so we can override the footer when the
  // workflow is in a passive-wait or terminal state. Active states fall
  // through to the default isAgentWorking-based logic below.
  // If the workflow head isn't strictly newer than chat evidence (or isn't
  // fresh enough), ignore it entirely so it cannot hide/override fresher
  // terminal chat/run state.
  const deliveryLoopFooter = useMemo(
    () =>
      classifyDeliveryLoopFooter(
        canApplyDeliveryLoopFooterOverride ? deliveryLoopState : null,
      ),
    [deliveryLoopState, canApplyDeliveryLoopFooterOverride],
  );

  // Hide the "Waiting to start" indicator when the agent has already produced
  // messages — the status DB field may still be "queued" while the agent is
  // actively working due to broadcast-before-persist timing.
  //
  // Also suppress the footer entirely while a tool call is streaming: the
  // inline tool chip is a more specific indicator and three concurrent
  // "working" cues on screen was overwhelming. The retry pill (if present)
  // is a historical log entry in the transcript and is orthogonal to this
  // live-activity footer.
  //
  // Passive-wait: show the quieter footer regardless of isAgentWorking so
  // users see an accurate "Waiting for PR merge" / "Waiting for your input"
  // line instead of the misleading "Assistant is working" animation.
  //
  // Hidden (terminal states: done/stopped/terminated): skip the footer
  // entirely — nothing is happening.
  // Sandbox errors are a hard "sandbox is NOT ready" signal. When one is
  // the latest error on the thread, suppress the "Assistant is working"
  // footer: the red error box (which now carries its own inline Retry)
  // is the only accurate status cue. Previously the two rendered side by
  // side, leaving users unsure whether anything was actually happening.
  const hasSandboxError = isSandboxErrorType(errorType ?? null);

  const baseShowWorking =
    isAgentWorking &&
    !hasPendingToolCall &&
    !hasSandboxError &&
    !(
      hasAgentMessages &&
      threadStatus !== null &&
      isQueuedStatus(threadStatus)
    );

  const footerFreshness = useMemo(
    () =>
      getWorkingFooterFreshness({
        now: new Date(nowMs),
        isWorkingCandidate: baseShowWorking,
        threadChatUpdatedAt: threadChatUpdatedAt ?? null,
        deliveryLoopUpdatedAtIso: deliveryLoopUpdatedAtIso ?? null,
        uncertainMessage: "Waiting for updates",
      }),
    [baseShowWorking, deliveryLoopUpdatedAtIso, nowMs, threadChatUpdatedAt],
  );

  const showWorkingMessage =
    deliveryLoopFooter.kind === "passive"
      ? true
      : deliveryLoopFooter.kind === "hidden"
        ? false
        : baseShowWorking;

  const passiveWaitProp =
    deliveryLoopFooter.kind === "passive"
      ? {
          message: deliveryLoopFooter.message,
          reason: deliveryLoopBlockedReason ?? null,
        }
      : footerFreshness.kind === "uncertain"
        ? { message: footerFreshness.message, reason: null }
        : null;

  // Pre-assembled `messagePartProps`. Per-message components read this as
  // a single stable reference instead of reconstructing the object inline
  // (which broke `ChatMessage`'s memo every render).
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

  // Pre-compute once per `messages` update to avoid doing it inside the
  // render closure for each message (and so the per-message prop is a
  // stable primitive that React.memo can compare).
  const lastIndex = messages.length - 1;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TerragonThreadProvider value={ctx}>
        <div className="flex flex-col flex-1 gap-6 w-full max-w-chat mx-auto px-6 mt-12 mb-4">
          {messages.map((message, index) => {
            const isLatestMessage = index === lastIndex;
            switch (message.role) {
              case "user":
                return (
                  <TerragonUserMessage
                    key={message.id}
                    message={message}
                    messageIndex={index}
                    isLatestMessage={isLatestMessage}
                    isFirstUserMessage={index === 0}
                  />
                );
              case "agent":
                return (
                  <TerragonAssistantMessage
                    key={message.id}
                    message={message}
                    messageIndex={index}
                    isLatestMessage={isLatestMessage}
                    isLatestAgentMessage={index === latestAgentMessageIndex}
                  />
                );
              case "system":
                return (
                  <TerragonSystemMessage
                    key={message.id}
                    message={message}
                    messageIndex={index}
                    isLatestMessage={isLatestMessage}
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
              threadId={thread.id}
              passiveWait={passiveWaitProp}
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
