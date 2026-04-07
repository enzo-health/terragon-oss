"use client";

import { DBMessage, ThreadInfoFull } from "@terragon/shared";
import { type ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePlatform } from "@/hooks/use-platform";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { cn } from "@/lib/utils";
import { useSecondaryPanel } from "./hooks";
import {
  type ArtifactWorkspaceItem,
  getArtifactWorkspaceItemSummary,
} from "./secondary-panel-helpers";
import { MobileArtifactDrawer } from "./secondary-panel-mobile-drawer";
import {
  ARTIFACT_WORKSPACE_PANEL_ID,
  SecondaryPanelContent,
} from "./secondary-panel-shell";
import type { PromptBoxRef } from "./thread-context";

// Re-exports preserved for external importers and tests.
export {
  findArtifactDescriptorForPart,
  getArtifactWorkspaceItems,
  getArtifactWorkspaceViewState,
  resolveActiveArtifactId,
  type ArtifactWorkspaceItemSummary,
  type ArtifactWorkspaceStatus,
} from "./secondary-panel-helpers";
export { ARTIFACT_WORKSPACE_PANEL_ID } from "./secondary-panel-shell";

const SECONDARY_PANEL_MIN_WIDTH = 300;
const SECONDARY_PANEL_MAX_WIDTH_PERCENTAGE = 0.7;
const SECONDARY_PANEL_MAXIMIZED_WIDTH_PERCENTAGE = 0.95;
const SECONDARY_PANEL_DEFAULT_WIDTH = 0.5;
const SECONDARY_PANEL_RESIZE_STEP = 32;
const SECONDARY_PANEL_FALLBACK_CONTAINER_WIDTH = 1024;

export function SecondaryPanel({
  thread,
  artifactDescriptors,
  activeArtifactId,
  onActiveArtifactChange,
  containerRef,
  messages = [],
  threadChatId,
  isReadOnly = false,
  promptBoxRef,
}: {
  thread: ThreadInfoFull;
  artifactDescriptors: ArtifactDescriptor[];
  activeArtifactId: string | null;
  onActiveArtifactChange: (artifactId: string | null) => void;
  containerRef: React.RefObject<HTMLElement | null>;
  messages?: DBMessage[];
  threadChatId?: string;
  isReadOnly?: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
}) {
  const platform = usePlatform();
  const {
    isSecondaryPanelOpen: isOpen,
    setIsSecondaryPanelOpen: onOpenChange,
  } = useSecondaryPanel();
  const artifacts = useMemo<ArtifactWorkspaceItem[]>(
    () =>
      artifactDescriptors.map((descriptor) => ({
        ...getArtifactWorkspaceItemSummary(descriptor),
        descriptor,
      })),
    [artifactDescriptors],
  );

  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  const [isMaximized, setIsMaximized] = useState(false);
  const previousWidthRef = useRef<number | null>(null);

  const { width, setWidth, isResizing, handleMouseDown } = useResizablePanel({
    minWidth: SECONDARY_PANEL_MIN_WIDTH,
    maxWidth: SECONDARY_PANEL_MAX_WIDTH_PERCENTAGE,
    defaultWidth: SECONDARY_PANEL_DEFAULT_WIDTH,
    mode: "percentage",
    direction: "rtl",
    containerRef,
    enabled: isOpen && platform === "desktop",
  });

  const getContainerWidth = useCallback(() => {
    return (
      containerRef.current?.offsetWidth ??
      (typeof window !== "undefined"
        ? window.innerWidth
        : SECONDARY_PANEL_FALLBACK_CONTAINER_WIDTH)
    );
  }, [containerRef]);

  const getSecondaryPanelMaxWidth = useCallback(() => {
    return getContainerWidth() * SECONDARY_PANEL_MAX_WIDTH_PERCENTAGE;
  }, [getContainerWidth]);

  const clampSecondaryPanelWidth = useCallback(
    (nextWidth: number) => {
      return Math.min(
        Math.max(nextWidth, SECONDARY_PANEL_MIN_WIDTH),
        getSecondaryPanelMaxWidth(),
      );
    },
    [getSecondaryPanelMaxWidth],
  );

  const widthRef = useRef(width);
  widthRef.current = width;

  const toggleMaximize = useCallback(() => {
    setIsMaximized((prev) => {
      if (!prev) {
        previousWidthRef.current = widthRef.current;
        setWidth(
          getContainerWidth() * SECONDARY_PANEL_MAXIMIZED_WIDTH_PERCENTAGE,
        );
        return true;
      } else {
        const restoreWidth =
          previousWidthRef.current ??
          getContainerWidth() * SECONDARY_PANEL_DEFAULT_WIDTH;
        setWidth(clampSecondaryPanelWidth(restoreWidth));
        return false;
      }
    });
  }, [setWidth, getContainerWidth, clampSecondaryPanelWidth]);

  // Keyboard shortcut: Cmd+Shift+F (Mac) / Ctrl+Shift+F (other)
  useEffect(() => {
    if (!isOpen || platform === "mobile") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const modKey = e.metaKey || e.ctrlKey;
      if (modKey && e.shiftKey && e.key === "F") {
        e.preventDefault();
        toggleMaximize();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, platform, toggleMaximize]);

  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isMaximized) return;
    let nextWidth = width;

    switch (event.key) {
      case "ArrowLeft":
        nextWidth = width + SECONDARY_PANEL_RESIZE_STEP;
        break;
      case "ArrowRight":
        nextWidth = width - SECONDARY_PANEL_RESIZE_STEP;
        break;
      case "Home":
        nextWidth = SECONDARY_PANEL_MIN_WIDTH;
        break;
      case "End":
        nextWidth = getSecondaryPanelMaxWidth();
        break;
      default:
        return;
    }

    event.preventDefault();
    setWidth(clampSecondaryPanelWidth(nextWidth));
  };

  if (platform === "mobile") {
    return (
      <MobileArtifactDrawer
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        artifacts={artifacts}
        activeArtifactId={activeArtifactId}
        onActiveArtifactChange={onActiveArtifactChange}
        onClose={handleClose}
        thread={thread}
        messages={messages}
        threadChatId={threadChatId}
        isReadOnly={isReadOnly}
        promptBoxRef={promptBoxRef}
      />
    );
  }

  if (!isOpen) return null;

  return (
    <>
      <div
        className={cn(
          "w-1.5 transition-colors flex-shrink-0",
          isMaximized
            ? "cursor-default"
            : "cursor-col-resize hover:bg-blue-500/50",
          isResizing && !isMaximized && "bg-blue-500/50",
        )}
        onMouseDown={isMaximized ? undefined : handleMouseDown}
        onKeyDown={isMaximized ? undefined : handleResizeKeyDown}
        role="separator"
        tabIndex={isMaximized ? -1 : 0}
        aria-label="Resize artifact workspace"
        aria-controls={ARTIFACT_WORKSPACE_PANEL_ID}
        aria-orientation="vertical"
        aria-valuemin={SECONDARY_PANEL_MIN_WIDTH}
        aria-valuemax={Math.round(
          isMaximized
            ? getContainerWidth() * SECONDARY_PANEL_MAXIMIZED_WIDTH_PERCENTAGE
            : getSecondaryPanelMaxWidth(),
        )}
        aria-valuenow={Math.round(width)}
        aria-valuetext={`${Math.round(width)} pixels wide`}
        title={
          isMaximized
            ? undefined
            : "Drag or use arrow keys to resize the artifact workspace"
        }
      />
      <div
        className="flex-shrink-0 border-l bg-background flex flex-col h-full"
        style={{ width: `${width}px` }}
      >
        <SecondaryPanelContent
          artifacts={artifacts}
          activeArtifactId={activeArtifactId}
          onActiveArtifactChange={onActiveArtifactChange}
          onClose={handleClose}
          onToggleMaximize={toggleMaximize}
          isMaximized={isMaximized}
          thread={thread}
          messages={messages}
          threadChatId={threadChatId}
          isReadOnly={isReadOnly}
          promptBoxRef={promptBoxRef}
        />
      </div>
    </>
  );
}
