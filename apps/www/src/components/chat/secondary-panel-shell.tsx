import { DBMessage, ThreadInfoFull } from "@terragon/shared";
import {
  type ArtifactDescriptor,
  type PlanArtifactDescriptor,
} from "@terragon/shared/db/artifact-descriptors";
import { Maximize2, Minimize2, X } from "lucide-react";
import React, { useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GitDiffView } from "./git-diff-view";
import { DocumentArtifactRenderer } from "./secondary-panel-document";
import {
  type ArtifactWorkspaceItem,
  getArtifactWorkspaceViewState,
  resolveActiveArtifactId,
} from "./secondary-panel-helpers";
import { MediaArtifactRenderer } from "./secondary-panel-media";
import { PlanArtifactRenderer } from "./secondary-panel-plan";
import { ArtifactWorkspaceState } from "./secondary-panel-state";
import { TextFileArtifactRenderer } from "./secondary-panel-text-file";
import type { PromptBoxRef } from "./thread-context";

export const ARTIFACT_WORKSPACE_PANEL_ID = "artifact-workspace-panel";

export function SecondaryPanelContent({
  artifacts,
  activeArtifactId,
  onActiveArtifactChange,
  onClose,
  onToggleMaximize,
  isMaximized,
  thread,
  messages,
  threadChatId,
  isReadOnly,
  promptBoxRef,
  onOptimisticPermissionModeUpdate,
}: {
  artifacts: ArtifactWorkspaceItem[];
  activeArtifactId: string | null;
  onActiveArtifactChange: (artifactId: string | null) => void;
  onClose: () => void;
  onToggleMaximize?: () => void;
  isMaximized?: boolean;
  thread: ThreadInfoFull;
  messages: DBMessage[];
  threadChatId?: string;
  isReadOnly?: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
  onOptimisticPermissionModeUpdate?: (mode: "allowAll" | "plan") => void;
}) {
  return (
    <ArtifactWorkspaceShell
      artifacts={artifacts}
      activeArtifactId={activeArtifactId}
      onActiveArtifactChange={onActiveArtifactChange}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      isMaximized={isMaximized}
      thread={thread}
      messages={messages}
      threadChatId={threadChatId}
      isReadOnly={isReadOnly}
      promptBoxRef={promptBoxRef}
      onOptimisticPermissionModeUpdate={onOptimisticPermissionModeUpdate}
      emptyState={{
        title: "No artifacts yet",
        description:
          "Artifacts like diffs and generated outputs will appear here.",
      }}
    />
  );
}

function ArtifactWorkspaceShell({
  artifacts,
  activeArtifactId,
  onActiveArtifactChange,
  onClose,
  onToggleMaximize,
  isMaximized,
  thread,
  messages,
  threadChatId,
  isReadOnly,
  promptBoxRef,
  onOptimisticPermissionModeUpdate,
  emptyState,
}: {
  artifacts: ArtifactWorkspaceItem[];
  activeArtifactId: string | null;
  onActiveArtifactChange: (artifactId: string | null) => void;
  onClose?: () => void;
  onToggleMaximize?: () => void;
  isMaximized?: boolean;
  thread: ThreadInfoFull;
  messages: DBMessage[];
  threadChatId?: string;
  isReadOnly?: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
  onOptimisticPermissionModeUpdate?: (mode: "allowAll" | "plan") => void;
  emptyState: {
    title: string;
    description: string;
  };
}) {
  const tablistRef = useRef<HTMLDivElement>(null);
  const resolvedActiveArtifactId = resolveActiveArtifactId({
    artifacts,
    activeArtifactId,
  });
  const activeArtifact =
    artifacts.find((artifact) => artifact.id === resolvedActiveArtifactId) ??
    null;
  const viewState = getArtifactWorkspaceViewState(activeArtifact);
  const headerTitle = activeArtifact?.title ?? emptyState.title;
  const headerSummary = activeArtifact?.summary ?? emptyState.description;

  const handleTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const tabs =
        tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      if (!tabs || tabs.length === 0) return;

      const currentIndex = Array.from(tabs).findIndex(
        (tab) => tab === event.currentTarget,
      );
      let nextIndex: number | null = null;

      switch (event.key) {
        case "ArrowRight":
          nextIndex = (currentIndex + 1) % tabs.length;
          break;
        case "ArrowLeft":
          nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = tabs.length - 1;
          break;
        default:
          return;
      }

      event.preventDefault();
      const nextTab = tabs[nextIndex];
      if (nextTab) {
        nextTab.focus();
        const artifactId = nextTab.getAttribute("data-artifact-id");
        if (artifactId) onActiveArtifactChange(artifactId);
      }
    },
    [onActiveArtifactChange],
  );

  return (
    <div
      id={ARTIFACT_WORKSPACE_PANEL_ID}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      {/* Compact header — single row with title, controls, and artifact tabs */}
      <div className="border-b">
        <div className="flex items-center justify-between gap-2 px-3 h-10">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <h2
              className="truncate text-[13px] font-medium text-foreground"
              title={headerTitle}
            >
              {headerTitle}
            </h2>
            {headerSummary && (
              <>
                <span className="text-muted-foreground/30 shrink-0">·</span>
                <span className="text-[11px] text-muted-foreground truncate shrink-0">
                  {headerSummary}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {onToggleMaximize && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 rounded hover:bg-accent"
                onClick={onToggleMaximize}
                aria-label={
                  isMaximized ? "Restore panel size" : "Maximize panel"
                }
                title={isMaximized ? "Restore" : "Maximize"}
              >
                {isMaximized ? (
                  <Minimize2 className="size-3.5 opacity-50" />
                ) : (
                  <Maximize2 className="size-3.5 opacity-50" />
                )}
              </Button>
            )}
            {onClose && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 rounded hover:bg-accent"
                onClick={onClose}
                aria-label="Close panel"
              >
                <X className="size-3.5 opacity-50" />
              </Button>
            )}
          </div>
        </div>
        {artifacts.length > 1 && (
          <div
            ref={tablistRef}
            role="tablist"
            aria-label="Artifacts"
            className="flex gap-0 px-3 border-t border-border/50"
          >
            {artifacts.map((artifact) => {
              const isActive = artifact.id === resolvedActiveArtifactId;
              return (
                <button
                  key={artifact.id}
                  type="button"
                  role="tab"
                  id={`artifact-tab-${artifact.id}`}
                  aria-selected={isActive}
                  aria-controls={`artifact-panel-${artifact.id}`}
                  tabIndex={isActive ? 0 : -1}
                  data-artifact-id={artifact.id}
                  className={cn(
                    "px-3 py-1.5 text-[11px] font-medium transition-colors border-b-2",
                    isActive
                      ? "text-foreground border-foreground"
                      : "text-muted-foreground border-transparent hover:text-foreground",
                  )}
                  onClick={() => onActiveArtifactChange(artifact.id)}
                  onKeyDown={handleTabKeyDown}
                >
                  {artifact.title}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div
        className="flex-1 min-h-0 overflow-hidden"
        role="tabpanel"
        id={activeArtifact ? `artifact-panel-${activeArtifact.id}` : undefined}
        aria-labelledby={
          activeArtifact ? `artifact-tab-${activeArtifact.id}` : undefined
        }
      >
        {viewState === "empty" && (
          <ArtifactWorkspaceState
            variant="empty"
            title={emptyState.title}
            description={emptyState.description}
          />
        )}

        {viewState === "loading" && (
          <ArtifactWorkspaceState
            variant="loading"
            title="Loading artifact"
            description="The selected artifact is still being prepared."
          />
        )}

        {viewState === "error" && (
          <ArtifactWorkspaceState
            variant="error"
            title={activeArtifact?.title ?? "Artifact unavailable"}
            description={
              activeArtifact?.errorMessage ??
              "Something went wrong while preparing this artifact."
            }
          />
        )}

        {viewState === "ready" && activeArtifact && (
          <div className="h-full">
            <ActiveArtifactRenderer
              key={activeArtifact.id}
              descriptor={activeArtifact.descriptor}
              thread={thread}
              messages={messages}
              threadChatId={threadChatId}
              isReadOnly={isReadOnly}
              promptBoxRef={promptBoxRef}
              onOptimisticPermissionModeUpdate={
                onOptimisticPermissionModeUpdate
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ActiveArtifactRenderer({
  descriptor,
  thread,
  messages,
  threadChatId,
  isReadOnly,
  promptBoxRef,
  onOptimisticPermissionModeUpdate,
}: {
  descriptor: ArtifactDescriptor;
  thread: ThreadInfoFull;
  messages: DBMessage[];
  threadChatId?: string;
  isReadOnly?: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
  onOptimisticPermissionModeUpdate?: (mode: "allowAll" | "plan") => void;
}) {
  switch (descriptor.kind) {
    case "git-diff":
      return <GitDiffView thread={thread} diffPart={descriptor.part} />;
    case "document":
      return <DocumentArtifactRenderer richTextPart={descriptor.part} />;
    case "file":
      return <TextFileArtifactRenderer textFilePart={descriptor.part} />;
    case "media":
      return <MediaArtifactRenderer mediaPart={descriptor.part} />;
    case "plan":
      return (
        <PlanArtifactRenderer
          descriptor={descriptor as PlanArtifactDescriptor}
          messages={messages}
          threadId={thread.id}
          threadChatId={threadChatId}
          isReadOnly={isReadOnly}
          onOptimisticPermissionModeUpdate={onOptimisticPermissionModeUpdate}
        />
      );
    default:
      return null;
  }
}
