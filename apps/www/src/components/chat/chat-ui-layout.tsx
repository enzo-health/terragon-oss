"use client";

import type { HttpAgent } from "@ag-ui/client";
import { AIAgent } from "@terragon/agent/types";
import {
  DBUserMessage,
  ThreadErrorMessage,
  ThreadInfoFull,
} from "@terragon/shared";
import { ArrowDown } from "lucide-react";
import dynamic from "next/dynamic";
import React, { useCallback } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAgUiQueryInvalidator } from "@/hooks/use-ag-ui-query-invalidator";
import { getLastUserMessageModel } from "@/lib/db-message-helpers";
import { cn } from "@/lib/utils";
import { stopThread } from "@/server-actions/stop-thread";
import { AgUiAgentProvider } from "./ag-ui-agent-context";
import {
  TerragonThread,
  TerragonThreadErrorBoundary,
} from "./assistant-ui/terragon-thread";
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
 * The `<AgUiQueryInvalidatorMount/>` lives inside the `<AgUiAgentProvider/>`
 * so it can read the agent from context.
 */
export function ChatUILayout(props: ChatUILayoutProps) {
  const {
    agent,
    chatAgent,
    isReadOnly,
    threadId,
    threadChatId,
    threadChat,
    thread,
    threadWithViewModelStatus,
    threadViewModel,
    messages,
    queuedMessages,
    artifactDescriptors,
    effectiveThreadStatus,
    isAgentCurrentlyWorking,
    redoDialogData,
    forkDialogData,
    toolProps,
    lastUsedModel,
    error,
    setError,
    handleRetry,
    isRetrying,
    handleOpenArtifact,
    activeArtifactId,
    setActiveArtifactId,
    showTerminal,
    setShowTerminal,
    shouldRenderSecondaryPanel,
    platform,
    scrollToTop,
    transcriptRef,
    scrollAreaRef,
    chatContainerRef,
    messagesEndRef,
    forceScrollToBottom,
    isAtBottom,
    hasInitialized,
    promptBoxRef,
    reconcileActiveChatFromServer,
    onOptimisticUserSubmit,
    onOptimisticQueuedMessagesUpdate,
    onOptimisticPermissionModeUpdate,
  } = props;

  const handleCancel = useCallback(async () => {
    await stopThread({
      threadId: thread.id,
      threadChatId: threadChat.id,
    });
  }, [thread.id, threadChat.id]);

  return (
    <AgUiAgentProvider agent={agent}>
      <AgUiQueryInvalidatorMount
        threadId={threadId}
        threadChatId={threadChatId}
      />
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
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="relative flex-1 overflow-hidden">
              <ScrollArea
                ref={scrollAreaRef}
                className="w-full h-full overflow-auto"
              >
                <div ref={transcriptRef} className="min-h-full flex flex-col">
                  <TerragonThreadErrorBoundary
                    threadStatus={effectiveThreadStatus}
                    handleRetry={handleRetry}
                    isReadOnly={isReadOnly}
                  >
                    <TerragonThread
                      agent={agent}
                      messages={messages}
                      lifecycleMessages={threadViewModel.lifecycleMessages}
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
                      error={error || threadChat.errorMessageInfo || undefined}
                      errorType={threadChat.errorMessage || undefined}
                      errorInfo={
                        error || threadChat.errorMessageInfo || undefined
                      }
                      handleRetry={handleRetry}
                      isRetrying={isRetrying}
                      isReadOnly={isReadOnly}
                      chatAgent={chatAgent}
                      bootingSubstatus={thread.bootingSubstatus ?? undefined}
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
                  className="shrink-0 min-w-[24px] min-h-[24px]"
                />
              </ScrollArea>
              {/* Scroll-to-bottom button floating above scroll area */}
              <div className="absolute bottom-3 left-0 right-0 flex justify-center pointer-events-none z-10">
                <button
                  onClick={forceScrollToBottom}
                  className={cn(
                    "pointer-events-auto flex size-10 items-center justify-center rounded-full bg-background border border-border/60 shadow-sm transition-[opacity,transform,scale,box-shadow,background-color] duration-[var(--duration-base)] ease-[var(--ease-emphasis)] hover:shadow-md active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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

function AgUiQueryInvalidatorMount({
  threadId,
  threadChatId,
}: {
  threadId: string;
  threadChatId: string | null;
}): null {
  // Must be rendered INSIDE `AgUiAgentProvider` so the hook can read the
  // current `HttpAgent` from context.
  useAgUiQueryInvalidator({ threadId, threadChatId });
  return null;
}

export type ChatUILayoutProps = {
  agent: HttpAgent;
  chatAgent: AIAgent;
  isReadOnly: boolean;
  threadId: string;
  threadChatId: string;
  threadChat: ThreadPageChat;
  thread: ThreadInfoFull;
  threadWithViewModelStatus: ThreadInfoFull;
  threadViewModel: ThreadViewModelController;
  messages: ThreadViewModelController["messages"];
  queuedMessages: DBUserMessage[] | null;
  artifactDescriptors: ThreadViewModelController["artifacts"]["descriptors"];
  effectiveThreadStatus: ThreadViewModelController["lifecycle"]["threadStatus"];
  isAgentCurrentlyWorking: boolean;
  redoDialogData: React.ComponentProps<typeof ChatHeader>["redoDialogData"];
  forkDialogData: React.ComponentProps<typeof TerragonThread>["forkDialogData"];
  toolProps: React.ComponentProps<typeof TerragonThread>["toolProps"];
  lastUsedModel: ReturnType<typeof getLastUserMessageModel>;
  error: ThreadErrorMessage | null;
  setError: (error: ThreadErrorMessage | null) => void;
  handleRetry: () => Promise<void>;
  isRetrying: boolean;
  handleOpenArtifact: (artifactId: string) => void;
  activeArtifactId: string | null;
  setActiveArtifactId: (id: string | null) => void;
  showTerminal: boolean;
  setShowTerminal: (show: boolean) => void;
  shouldRenderSecondaryPanel: boolean;
  platform: "unknown" | "mobile" | "desktop";
  scrollToTop: () => void;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  scrollAreaRef: React.RefObject<HTMLDivElement | null>;
  chatContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  forceScrollToBottom: () => void;
  isAtBottom: boolean;
  hasInitialized: boolean;
  promptBoxRef: React.RefObject<{
    focus: () => void;
    setPermissionMode: (mode: "allowAll" | "plan") => void;
  } | null>;
  reconcileActiveChatFromServer: () => Promise<unknown>;
  onOptimisticUserSubmit: React.ComponentProps<
    typeof ChatPromptBox
  >["onOptimisticUserSubmit"];
  onOptimisticQueuedMessagesUpdate: (messages: DBUserMessage[]) => void;
  onOptimisticPermissionModeUpdate: (mode: "allowAll" | "plan") => void;
};
