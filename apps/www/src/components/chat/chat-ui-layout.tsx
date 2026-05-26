"use client";

import type { HttpAgent } from "@ag-ui/client";
import type { AppendMessage } from "@assistant-ui/react";
import {
  AIModelSchema,
  type AIAgent,
  type AIModel,
} from "@terragon/agent/types";
import {
  DBUserMessage,
  ThreadErrorMessage,
  ThreadInfoFull,
} from "@terragon/shared";
import { ArrowDown } from "lucide-react";
import dynamic from "next/dynamic";
import React, { useCallback } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  convertToPlainText,
  getLastUserMessageModel,
} from "@/lib/db-message-helpers";
import { cn } from "@/lib/utils";
import { AgUiAgentProvider } from "./ag-ui-agent-context";
import { useThreadIntent } from "@/hooks/use-thread-intent";
import type { AgUiHistoryMessagesResult } from "@/lib/ag-ui-history-types";
import {
  TerragonThreadErrorBoundary,
  TerragonThreadRuntimeFrame,
} from "./assistant-ui/terragon-thread";
import { TerragonThreadRuntimeContent } from "./assistant-ui/terragon-thread-runtime-content";
import { ChatHeader } from "./chat-header";
import { ChatPromptBox } from "./chat-prompt-box";
import { appendUniqueQueuedMessages } from "./queued-message-dedupe";
import type { ThreadPageChat } from "@terragon/shared/db/types";
import type { ThreadViewModelController } from "./use-ag-ui-messages";

type ChatRuntimeQueueParams = {
  forceScrollToBottom: () => void;
  isAgentCurrentlyWorking: boolean;
  onOptimisticQueuedMessagesUpdate: (messages: DBUserMessage[]) => void;
  queueWriteRef: React.MutableRefObject<Promise<void>>;
  queuedMessagesRef: React.MutableRefObject<DBUserMessage[] | null>;
  reconcileActiveChatFromServer: () => Promise<unknown>;
  setError: (error: string | null) => void;
  threadChatId: string;
  threadId: string;
  publish: (intent: {
    type: "queue-message";
    threadId: string;
    threadChatId: string;
    messages: DBUserMessage[];
  }) => Promise<unknown>;
};

const TerminalPanel = dynamic(
  () => import("./terminal-panel").then((mod) => mod.TerminalPanel),
  { ssr: false },
);

const SecondaryPanel = dynamic(
  () => import("./secondary-panel").then((mod) => mod.SecondaryPanel),
  { ssr: false },
);

type TerragonComposerRunConfig = {
  selectedModel: AIModel | null;
  permissionMode: "allowAll" | "plan";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readTerragonComposerRunConfig(
  message: AppendMessage,
): TerragonComposerRunConfig {
  const fallback: TerragonComposerRunConfig = {
    selectedModel: null,
    permissionMode: "allowAll",
  };
  const custom = message.runConfig?.custom;
  if (!isRecord(custom)) {
    return fallback;
  }
  const terragon = custom.terragon;
  if (!isRecord(terragon)) {
    return fallback;
  }
  const selectedModelResult = AIModelSchema.safeParse(terragon.selectedModel);
  return {
    selectedModel: selectedModelResult.success
      ? selectedModelResult.data
      : null,
    permissionMode:
      terragon.permissionMode === "plan" ? "plan" : fallback.permissionMode,
  };
}

function appendMessageToDbUserMessage(message: AppendMessage): DBUserMessage {
  const config = readTerragonComposerRunConfig(message);
  const attachmentParts: DBUserMessage["parts"][number][] = [];
  const richTextNodes: Extract<
    DBUserMessage["parts"][number],
    { type: "rich-text" }
  >["nodes"] = [];

  if (message.role !== "user") {
    throw new Error(`Cannot queue non-user message: ${message.role}`);
  }

  for (const part of message.content) {
    if (part.type === "text") {
      richTextNodes.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      if (typeof part.image === "string") {
        attachmentParts.push({
          type: "image",
          image_url: part.image,
          mime_type: "image/png",
        });
      }
    }
  }

  return {
    type: "user",
    model: config.selectedModel,
    parts: [{ type: "rich-text", nodes: richTextNodes }, ...attachmentParts],
    timestamp: new Date().toISOString(),
    permissionMode: config.permissionMode,
  };
}

export function createChatRuntimeQueue({
  forceScrollToBottom,
  isAgentCurrentlyWorking,
  onOptimisticQueuedMessagesUpdate,
  publish,
  queueWriteRef,
  queuedMessagesRef,
  reconcileActiveChatFromServer,
  setError,
  threadChatId,
  threadId,
}: ChatRuntimeQueueParams): {
  shouldQueue: (message: AppendMessage) => boolean;
  enqueue: (message: AppendMessage) => Promise<void>;
} {
  const clientSubmissionIds = new WeakMap<AppendMessage, string>();
  const clientSubmissionIdFor = (message: AppendMessage): string => {
    if (typeof message.sourceId === "string" && message.sourceId.length > 0) {
      return message.sourceId;
    }
    const existing = clientSubmissionIds.get(message);
    if (existing) {
      return existing;
    }
    const next = crypto.randomUUID();
    clientSubmissionIds.set(message, next);
    return next;
  };

  return {
    shouldQueue: (message: AppendMessage) =>
      message.role === "user" && isAgentCurrentlyWorking,
    enqueue: async (message: AppendMessage) => {
      const userMessage = appendMessageToDbUserMessage(message);
      const plainText = convertToPlainText({ message: userMessage });
      if (plainText.length === 0) {
        return;
      }
      const queuedUserMessage = {
        clientSubmissionId: clientSubmissionIdFor(message),
        message: userMessage,
      };
      forceScrollToBottom();
      setError(null);
      const write = queueWriteRef.current
        .catch(() => undefined)
        .then(async () => {
          const baseQueuedMessages = queuedMessagesRef.current ?? [];
          const nextMessages = appendUniqueQueuedMessages(baseQueuedMessages, [
            queuedUserMessage,
          ]);
          if (nextMessages === baseQueuedMessages) {
            return;
          }
          queuedMessagesRef.current = nextMessages;
          onOptimisticQueuedMessagesUpdate(nextMessages);
          try {
            await publish({
              type: "queue-message",
              threadId,
              threadChatId,
              messages: nextMessages,
            });
          } catch {
            setError("Failed to queue follow-up");
            await reconcileActiveChatFromServer();
            return;
          }
          await reconcileActiveChatFromServer();
        });
      queueWriteRef.current = write.catch(() => undefined);
      await write;
    },
  };
}

/**
 * Pure presentation: composes the chat header, scroll-area transcript, prompt
 * box, secondary panel, and terminal-panel overlay. All data and dispatchers
 * are passed in by `ChatUIContent` — this component holds no React Query,
 * no transport state, no view-model wiring.
 *
 * Props are grouped by concern (coreData, viewModel, scrollState, panelState,
 * dialogData, optimisticHandlers, errorState) so future state additions only
 * widen the relevant group rather than the whole signature. Each group is
 * `useMemo`-stabilized in `ChatUIContent` to keep referential identity stable
 * across parent re-renders.
 */
export function ChatUILayout(props: ChatUILayoutProps) {
  const {
    coreData,
    viewModel,
    scrollState,
    panelState,
    dialogData,
    optimisticHandlers,
    errorState,
  } = props;

  const {
    agent,
    chatAgent,
    isReadOnly,
    threadChat,
    thread,
    threadWithViewModelStatus,
  } = coreData;

  const {
    threadViewModel,
    loadAgUiHistoryMessages,
    queuedMessages,
    optimisticUserMessages,
    artifactDescriptors,
    effectiveThreadStatus,
    isAgentCurrentlyWorking,
    toolProps,
    lastUsedModel,
    handleOpenArtifact,
  } = viewModel;

  const {
    transcriptRef,
    scrollAreaRef,
    chatContainerRef,
    messagesEndRef,
    promptBoxRef,
    forceScrollToBottom,
    scrollToTop,
    isAtBottom,
    hasInitialized,
  } = scrollState;

  const {
    activeArtifactId,
    setActiveArtifactId,
    showTerminal,
    setShowTerminal,
    shouldRenderSecondaryPanel,
    platform,
  } = panelState;

  const { redoDialogData, forkDialogData } = dialogData;

  const {
    onOptimisticUserSubmit,
    onOptimisticQueuedMessagesUpdate,
    onOptimisticPermissionModeUpdate,
    reconcileActiveChatFromServer,
  } = optimisticHandlers;

  const { error, setError, isRetrying, handleRetry } = errorState;
  const queuedMessagesRef = React.useRef(queuedMessages);
  const queueWriteRef = React.useRef<Promise<void>>(Promise.resolve());

  React.useEffect(() => {
    queuedMessagesRef.current = queuedMessages;
  }, [queuedMessages]);

  const { publish } = useThreadIntent();

  const handleCancel = useCallback(async () => {
    try {
      await publish({
        type: "stop-thread",
        threadId: thread.id,
        threadChatId: threadChat.id,
      });
    } catch {
      // Error already handled by subscriber
    }
  }, [thread.id, threadChat.id, publish]);

  const runtimeQueue = React.useMemo(
    () =>
      createChatRuntimeQueue({
        forceScrollToBottom,
        isAgentCurrentlyWorking,
        onOptimisticQueuedMessagesUpdate,
        publish,
        queueWriteRef,
        queuedMessagesRef,
        reconcileActiveChatFromServer,
        setError,
        threadId: thread.id,
        threadChatId: threadChat.id,
      }),
    [
      forceScrollToBottom,
      isAgentCurrentlyWorking,
      onOptimisticQueuedMessagesUpdate,
      publish,
      reconcileActiveChatFromServer,
      setError,
      thread.id,
      threadChat.id,
    ],
  );

  return (
    <AgUiAgentProvider agent={agent}>
      <div className="flex flex-col h-full w-full">
        <ChatHeader
          thread={threadWithViewModelStatus}
          threadAgent={chatAgent}
          redoDialogData={redoDialogData}
          isReadOnly={isReadOnly}
          onHeaderClick={platform === "mobile" ? scrollToTop : undefined}
          onTerminalClick={() => setShowTerminal(true)}
          metaSnapshot={threadViewModel.meta}
          githubSummary={threadViewModel.githubSummary}
        />
        <div ref={chatContainerRef} className="flex flex-1 overflow-hidden">
          <TerragonThreadRuntimeFrame
            agent={agent}
            loadAgUiHistoryMessages={loadAgUiHistoryMessages}
            onCancel={handleCancel}
            chatAgent={chatAgent}
            isAgentWorking={isAgentCurrentlyWorking}
            threadId={thread.id}
            threadChatId={threadChat.id}
            callerError={error || threadChat.errorMessageInfo || undefined}
            callerErrorType={threadChat.errorMessage || undefined}
            callerErrorInfo={error || threadChat.errorMessageInfo || undefined}
            runtimeQueue={runtimeQueue}
          >
            {(runtimeProps) => (
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="relative flex-1 overflow-hidden">
                  <ScrollArea
                    ref={scrollAreaRef}
                    className="w-full h-full overflow-auto"
                    viewportClassName="[scrollbar-gutter:stable] [overflow-anchor:none]"
                  >
                    <div
                      ref={transcriptRef}
                      className="min-h-full flex flex-col [overflow-anchor:none]"
                    >
                      <TerragonThreadErrorBoundary
                        threadStatus={effectiveThreadStatus}
                        isReadOnly={isReadOnly}
                      >
                        <TerragonThreadRuntimeContent
                          lifecycleMessages={threadViewModel.lifecycleMessages}
                          optimisticUserMessages={optimisticUserMessages}
                          threadStatus={effectiveThreadStatus}
                          thread={threadWithViewModelStatus}
                          latestGitDiffTimestamp={
                            threadViewModel.latestGitDiffTimestamp
                          }
                          isAgentWorking={isAgentCurrentlyWorking}
                          threadChatUpdatedAt={
                            threadViewModel.lifecycle.threadChatUpdatedAt
                          }
                          artifactDescriptors={artifactDescriptors}
                          onOpenArtifact={handleOpenArtifact}
                          onCancel={handleCancel}
                          redoDialogData={redoDialogData}
                          forkDialogData={forkDialogData}
                          toolProps={toolProps}
                          hasCheckpoint={threadViewModel.hasCheckpoint}
                          error={error || threadChat.errorMessageInfo}
                          errorType={runtimeProps.errorType}
                          errorInfo={runtimeProps.errorInfo}
                          handleRetry={runtimeProps.handleRetry ?? handleRetry}
                          isRetrying={runtimeProps.isRetrying ?? isRetrying}
                          isReadOnly={isReadOnly}
                          chatAgent={chatAgent}
                          bootingSubstatus={
                            thread.bootingSubstatus ?? undefined
                          }
                          metaSnapshot={threadViewModel.meta}
                          reattemptQueueAt={threadChat.reattemptQueueAt ?? null}
                          threadChatId={threadChat.id}
                          scheduleAt={threadChat.scheduleAt}
                          threadChatStatus={threadChat.status}
                        />
                      </TerragonThreadErrorBoundary>
                    </div>
                    <div
                      ref={messagesEndRef}
                      className="shrink-0 min-w-[24px] min-h-[24px] [overflow-anchor:auto]"
                    />
                  </ScrollArea>
                  {/* Scroll-to-bottom button floating above scroll area */}
                  <div className="absolute bottom-3 left-0 right-0 flex justify-center pointer-events-none z-10">
                    <button
                      onClick={forceScrollToBottom}
                      className={cn(
                        "pointer-events-auto flex size-10 items-center justify-center rounded-full bg-background border border-border/60 shadow-sm transition-[opacity,transform,scale,box-shadow,background-color] duration-[var(--duration-base)] ease-[var(--ease-emphasis)] hover:shadow-md active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        hasInitialized && !isAtBottom
                          ? "opacity-100 translate-y-0 scale-100"
                          : "opacity-0 translate-y-2 scale-95 pointer-events-none",
                      )}
                      aria-label="Scroll to bottom"
                    >
                      <ArrowDown className="size-4 text-muted-foreground" />
                    </button>
                  </div>
                </div>
                {!isReadOnly && (
                  <ChatPromptBox
                    threadId={thread.id}
                    threadChatId={threadChat.id}
                    threadStatus={effectiveThreadStatus}
                    bootingSubstatus={thread.bootingSubstatus ?? null}
                    runStarted={threadViewModel.lifecycle.runStarted}
                    queuedMessages={queuedMessages}
                    permissionMode={
                      threadViewModel.permissionMode ?? "allowAll"
                    }
                    prStatus={threadViewModel.githubSummary.prStatus}
                    prChecksStatus={
                      threadViewModel.githubSummary.prChecksStatus
                    }
                    githubPRNumber={
                      threadViewModel.githubSummary.githubPRNumber
                    }
                    sandboxId={thread.codesandboxId}
                    repoFullName={thread.githubRepoFullName}
                    branchName={thread.branchName ?? thread.repoBaseBranchName}
                    agent={chatAgent}
                    agentVersion={threadChat.agentVersion}
                    lastUsedModel={lastUsedModel}
                    contextLength={threadChat.contextLength ?? null}
                    setError={setError}
                    onOptimisticUserSubmit={onOptimisticUserSubmit}
                    onOptimisticQueuedMessagesUpdate={
                      onOptimisticQueuedMessagesUpdate
                    }
                    onPermissionModeChange={onOptimisticPermissionModeUpdate}
                    refetch={reconcileActiveChatFromServer}
                    forceScrollToBottom={forceScrollToBottom}
                    promptBoxRef={promptBoxRef}
                  />
                )}
              </div>
            )}
          </TerragonThreadRuntimeFrame>
          {shouldRenderSecondaryPanel ? (
            <SecondaryPanel
              thread={threadWithViewModelStatus}
              artifactDescriptors={artifactDescriptors}
              activeArtifactId={activeArtifactId}
              onActiveArtifactChange={setActiveArtifactId}
              containerRef={chatContainerRef}
              messages={threadViewModel.sidePanel.messages}
              threadChatId={threadViewModel.sidePanel.threadChatId}
              isReadOnly={isReadOnly}
              promptBoxRef={promptBoxRef}
              onOptimisticPermissionModeUpdate={
                onOptimisticPermissionModeUpdate
              }
            />
          ) : null}
        </div>
      </div>
      {showTerminal && thread.codesandboxId && (
        <TerminalPanel
          threadId={thread.id}
          sandboxId={thread.codesandboxId}
          sandboxProvider={thread.sandboxProvider}
          onClose={() => setShowTerminal(false)}
        />
      )}
    </AgUiAgentProvider>
  );
}

/**
 * Stable identity of the active thread / chat / agent. These rarely change in
 * a single render pass and form the immutable backbone the rest of the layout
 * depends on.
 */
export type ChatUICoreData = {
  agent: HttpAgent;
  chatAgent: AIAgent;
  isReadOnly: boolean;
  threadId: string;
  threadChatId: string;
  threadChat: ThreadPageChat;
  thread: ThreadInfoFull;
  threadWithViewModelStatus: ThreadInfoFull;
};

/**
 * Derived view-model state: messages, descriptors, status, tool wiring. Widens
 * whenever the AG-UI view model surfaces a new piece of data to the layout.
 */
export type ChatUIViewModelData = {
  threadViewModel: ThreadViewModelController;
  loadAgUiHistoryMessages: () => Promise<AgUiHistoryMessagesResult>;
  queuedMessages: DBUserMessage[] | null;
  optimisticUserMessages: React.ComponentProps<
    typeof TerragonThreadRuntimeContent
  >["optimisticUserMessages"];
  artifactDescriptors: ThreadViewModelController["artifacts"]["descriptors"];
  effectiveThreadStatus: ThreadViewModelController["lifecycle"]["threadStatus"];
  isAgentCurrentlyWorking: boolean;
  toolProps: React.ComponentProps<
    typeof TerragonThreadRuntimeContent
  >["toolProps"];
  lastUsedModel: ReturnType<typeof getLastUserMessageModel>;
  handleOpenArtifact: (artifactId: string) => void;
};

/**
 * DOM refs and scroll-position primitives for the transcript / prompt-box
 * scroll choreography.
 */
export type ChatUIScrollState = {
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  scrollAreaRef: React.RefObject<HTMLDivElement | null>;
  chatContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  promptBoxRef: React.RefObject<{
    focus: () => void;
    setPermissionMode: (mode: "allowAll" | "plan") => void;
  } | null>;
  forceScrollToBottom: () => void;
  scrollToTop: () => void;
  isAtBottom: boolean;
  hasInitialized: boolean;
};

/**
 * Visibility / selection state for the secondary (artifact) panel and terminal
 * overlay, plus the platform hint that drives mobile-vs-desktop behaviour.
 */
export type ChatUIPanelState = {
  activeArtifactId: string | null;
  setActiveArtifactId: (id: string | null) => void;
  showTerminal: boolean;
  setShowTerminal: (show: boolean) => void;
  shouldRenderSecondaryPanel: boolean;
  platform: "unknown" | "mobile" | "desktop";
};

/**
 * Pre-built data bundles for the redo and fork confirmation dialogs.
 */
export type ChatUIDialogData = {
  redoDialogData: React.ComponentProps<typeof ChatHeader>["redoDialogData"];
  forkDialogData: React.ComponentProps<
    typeof TerragonThreadRuntimeContent
  >["forkDialogData"];
};

/**
 * Optimistic-update dispatchers and the server-side reconciliation hook. These
 * write to the AG-UI view model before the round-trip completes.
 */
export type ChatUIOptimisticHandlers = {
  onOptimisticUserSubmit: React.ComponentProps<
    typeof ChatPromptBox
  >["onOptimisticUserSubmit"];
  onOptimisticQueuedMessagesUpdate: (messages: DBUserMessage[]) => void;
  onOptimisticPermissionModeUpdate: (mode: "allowAll" | "plan") => void;
  reconcileActiveChatFromServer: () => Promise<unknown>;
};

/**
 * Transient error banner state plus the retry mutation.
 */
export type ChatUIErrorState = {
  error: ThreadErrorMessage | null;
  setError: (error: ThreadErrorMessage | null) => void;
  isRetrying: boolean;
  handleRetry: () => Promise<void>;
};

export type ChatUILayoutProps = {
  coreData: ChatUICoreData;
  viewModel: ChatUIViewModelData;
  scrollState: ChatUIScrollState;
  panelState: ChatUIPanelState;
  dialogData: ChatUIDialogData;
  optimisticHandlers: ChatUIOptimisticHandlers;
  errorState: ChatUIErrorState;
};
