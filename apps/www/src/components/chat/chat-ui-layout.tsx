"use client";

import type { HttpAgent } from "@ag-ui/client";
import type { AIAgent } from "@terragon/agent/types";
import {
  DBUserMessage,
  ThreadErrorMessage,
  ThreadInfoFull,
} from "@terragon/shared";
import type { ThreadPageChat } from "@terragon/shared/db/types";
import dynamic from "next/dynamic";
import React from "react";
import type { AgUiReplayCursor } from "@/hooks/use-ag-ui-transport";
import type { AgUiHistoryMessagesResult } from "@/lib/ag-ui-history-types";
import { getLastUserMessageModel } from "@/lib/db-message-helpers";
import { AgUiAgentProvider } from "./ag-ui-agent-context";
import { ChatHeader } from "./chat-header";
import { ChatPromptBox } from "./chat-prompt-box";
import { ConversationPage } from "./conversation/conversation-page";
import type { ScrollController } from "./conversation/scroll-bridge";
import type { ThreadViewModelController } from "./use-thread-view-model";

const TerminalPanel = dynamic(
  () => import("./terminal-panel").then((mod) => mod.TerminalPanel),
  { ssr: false },
);

const SecondaryPanel = dynamic(
  () => import("./secondary-panel").then((mod) => mod.SecondaryPanel),
  { ssr: false },
);

/**
 * Pure presentation: composes the chat header, transcript, prompt box,
 * secondary panel, and terminal-panel overlay. All data and dispatchers are
 * passed in by `ChatUIContent` — this component holds no React Query, no
 * transport state, no view-model wiring.
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
    artifactDescriptors,
    effectiveThreadStatus,
    isAgentCurrentlyWorking,
    lastUsedModel,
    handleOpenArtifact,
    onOpenRepoFile,
    onOpenRepoTree,
    activeRepoFilePath,
  } = viewModel;

  const {
    chatContainerRef,
    scrollController,
    promptBoxRef,
    forceScrollToBottom,
    scrollToTop,
  } = scrollState;

  const {
    activeArtifactId,
    setActiveArtifactId,
    showTerminal,
    setShowTerminal,
    shouldRenderSecondaryPanel,
    platform,
  } = panelState;

  const { redoDialogData } = dialogData;

  const {
    onOptimisticUserSubmit,
    onOptimisticQueuedMessagesUpdate,
    onOptimisticPermissionModeUpdate,
    onAppendRejected,
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
          <div className="@container/chat flex-1 flex flex-col overflow-hidden min-w-0">
            <ConversationPage
              agent={agent}
              loadAgUiHistoryMessages={loadAgUiHistoryMessages}
              setReplayCursor={coreData.setReplayCursor}
              onAppendRejected={onAppendRejected}
              lifecycleMessages={threadViewModel.lifecycleMessages}
              threadStatus={effectiveThreadStatus}
              isAgentWorking={isAgentCurrentlyWorking}
              thread={thread}
              latestGitDiffTimestamp={threadViewModel.latestGitDiffTimestamp}
              artifactDescriptors={artifactDescriptors}
              onOpenArtifact={handleOpenArtifact}
              onOpenRepoFile={onOpenRepoFile}
              callerError={error || threadChat.errorMessageInfo || undefined}
              callerErrorType={threadChat.errorMessage || undefined}
              serverRetry={handleRetry}
              isServerRetrying={isRetrying}
              isReadOnly={isReadOnly}
              chatAgent={chatAgent}
              bootingSubstatus={thread.bootingSubstatus ?? undefined}
              metaSnapshot={threadViewModel.meta}
              reattemptQueueAt={threadChat.reattemptQueueAt ?? null}
              threadChatUpdatedAt={
                threadViewModel.lifecycle.threadChatUpdatedAt
              }
              threadId={thread.id}
              threadChatId={threadChat.id}
              scheduleAt={threadChat.scheduleAt}
              threadChatStatus={threadChat.status}
              scrollController={scrollController}
            />
            {!isReadOnly && (
              <ChatPromptBox
                threadId={thread.id}
                threadChatId={threadChat.id}
                threadStatus={effectiveThreadStatus}
                bootingSubstatus={thread.bootingSubstatus ?? null}
                runStarted={threadViewModel.lifecycle.runStarted}
                queuedMessages={queuedMessages}
                permissionMode={threadViewModel.permissionMode ?? "allowAll"}
                prStatus={threadViewModel.githubSummary.prStatus}
                prChecksStatus={threadViewModel.githubSummary.prChecksStatus}
                githubPRNumber={threadViewModel.githubSummary.githubPRNumber}
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
 * Derived view-model state: messages, descriptors, status. Widens whenever the
 * AG-UI view model surfaces a new piece of data to the layout.
 */
export type ChatUIViewModelData = {
  threadViewModel: ThreadViewModelController;
  loadAgUiHistoryMessages: () => Promise<AgUiHistoryMessagesResult>;
  queuedMessages: DBUserMessage[] | null;
  artifactDescriptors: ThreadViewModelController["artifacts"]["descriptors"];
  effectiveThreadStatus: ThreadViewModelController["lifecycle"]["threadStatus"];
  isAgentCurrentlyWorking: boolean;
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
  chatContainerRef: React.RefObject<HTMLDivElement | null>;
  scrollController: React.RefObject<ScrollController | null>;
  promptBoxRef: React.RefObject<{
    focus: () => void;
    setPermissionMode: (mode: "allowAll" | "plan") => void;
  } | null>;
  forceScrollToBottom: () => void;
  scrollToTop: () => void;
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
 * Pre-built data bundle for the redo confirmation dialog.
 */
export type ChatUIDialogData = {
  redoDialogData: React.ComponentProps<typeof ChatHeader>["redoDialogData"];
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
  onAppendRejected: (rejection: {
    kind: "rejected" | "lock-held";
    clientSubmissionId: string | null;
  }) => void;
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
