"use client";

import type { HttpAgent } from "@ag-ui/client";
import type { AIAgent } from "@terragon/agent/types";
import {
  DBUserMessage,
  ThreadErrorMessage,
  ThreadInfoFull,
} from "@terragon/shared";
import { ArrowDown } from "lucide-react";
import dynamic from "next/dynamic";
import React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getLastUserMessageModel } from "@/lib/db-message-helpers";
import { cn } from "@/lib/utils";
import type { AgUiReplayCursor } from "@/hooks/use-ag-ui-transport";
import { AgUiAgentProvider } from "./ag-ui-agent-context";
import type { AgUiHistoryMessagesResult } from "@/lib/ag-ui-history-types";
import { AssistantRuntimeSession } from "./assistant-ui/assistant-runtime-session";
import { TerragonThreadErrorBoundary } from "./assistant-ui/terragon-thread-error-boundary";
import { TerragonThreadRuntimeContent } from "./assistant-ui/terragon-thread-runtime-content";
import { ChatHeader } from "./chat-header";
import { ChatPromptBox } from "./chat-prompt-box";
import type { ThreadPageChat } from "@terragon/shared/db/types";
import type { ThreadViewModelController } from "./use-ag-ui-messages";

const TerminalPanel = dynamic(
  () => import("./terminal-panel").then((mod) => mod.TerminalPanel),
  { ssr: false },
);

const SecondaryPanel = dynamic(
  () => import("./secondary-panel").then((mod) => mod.SecondaryPanel),
  { ssr: false },
);

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
    onOpenRepoFile,
    onOpenRepoTree,
    activeRepoFilePath,
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

  return (
    <AgUiAgentProvider agent={agent}>
      <div className="@container/pane flex flex-col h-full w-full">
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
          <AssistantRuntimeSession
            agent={agent}
            loadAgUiHistoryMessages={loadAgUiHistoryMessages}
            chatAgent={chatAgent}
            isAgentWorking={isAgentCurrentlyWorking}
            threadId={thread.id}
            threadChatId={threadChat.id}
            setReplayCursor={coreData.setReplayCursor}
            callerError={error || threadChat.errorMessageInfo || undefined}
            callerErrorType={threadChat.errorMessage || undefined}
            callerErrorInfo={error || threadChat.errorMessageInfo || undefined}
          >
            {(runtimeProps) => (
              <div className="@container/chat flex-1 flex flex-col overflow-hidden min-w-0">
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
                          onOpenRepoFile={onOpenRepoFile}
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
          </AssistantRuntimeSession>
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
              onOpenRepoFile={onOpenRepoFile}
              onOpenRepoTree={onOpenRepoTree}
              activeRepoFilePath={activeRepoFilePath}
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
  setReplayCursor: (cursor: AgUiReplayCursor | null) => void;
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
  /**
   * Opens an in-repo file path (from a markdown link, tool-output affordance,
   * git-diff header, or git-diff file tree) as a dedicated repo-file artifact.
   */
  onOpenRepoFile?: (href: string) => void;
  /** Opens the repo file tree as a singleton artifact tab. */
  onOpenRepoTree?: () => void;
  /** Path of the most recently opened repo file, highlighted in the tree. */
  activeRepoFilePath?: string | null;
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
