"use client";

import type { HttpAgent } from "@ag-ui/client";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import type { BootingSubstatus } from "@terragon/sandbox/types";
import type {
  ThreadInfoFull,
  ThreadStatus,
  UIMessage,
  UISystemMessage,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { isQueuedStatus } from "@/agent/thread-status";
import { useStableRef } from "@/hooks/use-stable-ref";
import { useTerragonRuntime } from "../assistant-runtime";
import { ChatError, isSandboxErrorType } from "../chat-error";
import type {
  ForkDialogData,
  MessagePartRenderProps,
  RedoDialogData,
} from "../chat-message.types";
import { MessageScheduled, WorkingMessage } from "../chat-messages";
import type { ThreadMetaSnapshot } from "../meta-chips/use-thread-meta-events";
import { TerragonAssistantMessage } from "./assistant-message";
import { isEqualArtifactList, isEqualPlanMap } from "./ctx-stability";
import { buildThreadPlanOccurrenceMap } from "./plan-occurrences";
import { TerragonSystemMessage } from "./system-message";
import {
  type TerragonThreadContext,
  TerragonThreadProvider,
} from "./thread-context";
import { TerragonUserMessage } from "./user-message";

export function shouldSuppressPreStartLifecycleFooter(params: {
  threadStatus: ThreadStatus | null;
  hasAgentMessages: boolean;
}): boolean {
  const { threadStatus, hasAgentMessages } = params;
  if (!hasAgentMessages || threadStatus === null) {
    return false;
  }
  return threadStatus === "booting" || isQueuedStatus(threadStatus);
}

type WorkingFooterFreshness =
  | { kind: "fresh" }
  | { kind: "uncertain"; message: string };

function parseDateLike(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getWorkingFooterFreshness(params: {
  now: Date;
  isWorkingCandidate: boolean;
  threadChatUpdatedAt?: Date | string | null;
  uncertainMessage: string;
}): WorkingFooterFreshness {
  if (!params.isWorkingCandidate) {
    return { kind: "fresh" };
  }
  const threadChatUpdatedAt = parseDateLike(params.threadChatUpdatedAt);
  if (
    threadChatUpdatedAt &&
    params.now.getTime() - threadChatUpdatedAt.getTime() <= 5 * 60 * 1_000
  ) {
    return { kind: "fresh" };
  }
  return { kind: "uncertain", message: params.uncertainMessage };
}

type TerragonThreadProps = {
  /**
   * AG-UI transport agent powering the `AssistantRuntime`. Built by
   * `useAgUiTransport` in the parent and passed down.
   */
  agent: HttpAgent;
  /**
   * Rendered messages. The active task page passes the `ThreadViewModel`
   * transcript; assistant-ui powers runtime integration but is not transcript
   * authority.
   */
  messages: UIMessage[];
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
  metaSnapshot: ThreadMetaSnapshot;
  reattemptQueueAt: Date | null;
  /** `thread_chat.updatedAt` (durable). */
  threadChatUpdatedAt?: Date | string | null;
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
  lifecycleMessages,
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
  metaSnapshot,
  reattemptQueueAt,
  threadChatUpdatedAt,
  threadChatId,
  scheduleAt,
  threadChatStatus,
  children,
}: TerragonThreadProps) {
  // Only agents that emit reasoning / thinking events benefit from the
  // thinking UI. Other agents would show an empty "thinking" affordance.
  const showThinking = chatAgent === "claudeCode" || chatAgent === "codex";

  // Memoize the runtime config so `useTerragonRuntime` sees a stable input
  // across renders. Without this, the config object is reallocated on every
  // render (including every token delta), which churns the AG-UI runtime's
  // internal effect deps unnecessarily.
  const runtimeConfig = useMemo(
    () => ({
      agent,
      showThinking,
      onCancel,
    }),
    [agent, showThinking, onCancel],
  );

  const runtime = useTerragonRuntime(runtimeConfig);

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
  const shouldTickFreshnessClock = isAgentWorking;
  useEffect(() => {
    if (!shouldTickFreshnessClock) return;
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [shouldTickFreshnessClock]);

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
    !shouldSuppressPreStartLifecycleFooter({
      threadStatus,
      hasAgentMessages,
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

  const showWorkingMessage = baseShowWorking;

  const passiveWaitProp =
    footerFreshness.kind === "uncertain"
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
        {/* Macro chat rhythm:
            - mt-12 (48px) above first message: generous separation from header
            - gap-6 (24px) between messages: reading rhythm
            - mb-8 (32px) below last message: breathing room above the prompt box
            - max-w-chat caps body line length around 65–75ch via the
              --chat-max-width CSS var. */}
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
              metaSnapshot={metaSnapshot}
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

type TerragonThreadErrorBoundaryProps = {
  /** Status passed through to `<ChatError/>` when the boundary catches. */
  threadStatus: ThreadStatus | null;
  /** Optional retry handler — wired to the same `handleRetry` the live UI uses. */
  handleRetry?: () => Promise<void>;
  isReadOnly?: boolean;
  children: ReactNode;
};

type TerragonThreadErrorBoundaryState = {
  error: Error | null;
};

/**
 * Error boundary for `<TerragonThread/>`. Catches render-time runtime / SSE
 * errors that would otherwise unmount the chat tree and surface them via the
 * existing `<ChatError/>` fallback so the user sees a coherent message and a
 * retry affordance instead of a blank screen.
 *
 * Class component (no `react-error-boundary` dependency); the boundary is
 * placed at the consumer site so the rest of the chat shell (header, prompt
 * box) keeps rendering even when the transcript itself throws.
 */
export class TerragonThreadErrorBoundary extends Component<
  TerragonThreadErrorBoundaryProps,
  TerragonThreadErrorBoundaryState
> {
  state: TerragonThreadErrorBoundaryState = { error: null };

  static getDerivedStateFromError(
    error: Error,
  ): TerragonThreadErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the error to the console for debugging. Production telemetry
    // can hook in here later if needed.
    console.error("TerragonThread crashed:", error, info);
  }

  private handleRetry = async (): Promise<void> => {
    // Clear the error first so the tree gets a chance to re-mount even if
    // the caller's retry handler is a no-op or throws synchronously.
    this.setState({ error: null });
    if (this.props.handleRetry) {
      await this.props.handleRetry();
    }
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="flex flex-col flex-1 gap-6 w-full max-w-chat mx-auto px-4 sm:px-6 mt-12 mb-8">
          <ChatError
            status={this.props.threadStatus ?? "error"}
            errorType="unknown-error"
            errorInfo={error.message || "The chat UI crashed unexpectedly."}
            handleRetry={this.handleRetry}
            isReadOnly={this.props.isReadOnly ?? false}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
