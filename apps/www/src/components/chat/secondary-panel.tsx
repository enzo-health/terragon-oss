"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { ThreadInfoFull } from "@terragon/shared";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { GitDiffView } from "./git-diff-view";
import { usePlatform } from "@/hooks/use-platform";
import { useSecondaryPanel } from "./hooks";
import { PreviewPanel } from "./preview-panel";

const SECONDARY_PANEL_MIN_WIDTH = 300;
const SECONDARY_PANEL_MAX_WIDTH_PERCENTAGE = 0.7;
const SECONDARY_PANEL_DEFAULT_WIDTH = 0.5;

export function SecondaryPanel({
  thread,
  containerRef,
}: {
  thread: ThreadInfoFull;
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const platform = usePlatform();
  const {
    isSecondaryPanelOpen: isOpen,
    setIsSecondaryPanelOpen: onOpenChange,
  } = useSecondaryPanel();
  const { width, isResizing, handleMouseDown } = useResizablePanel({
    minWidth: SECONDARY_PANEL_MIN_WIDTH,
    maxWidth: SECONDARY_PANEL_MAX_WIDTH_PERCENTAGE,
    defaultWidth: SECONDARY_PANEL_DEFAULT_WIDTH,
    mode: "percentage",
    direction: "rtl",
    containerRef,
    enabled: isOpen && platform === "desktop",
  });
  if (platform === "mobile") {
    return (
      <Drawer open={isOpen} onOpenChange={onOpenChange}>
        <DrawerContent className="h-[80vh]">
          <SecondaryPanelContent thread={thread} />
        </DrawerContent>
      </Drawer>
    );
  }
  if (!isOpen) return null;
  return (
    <>
      <div
        className={cn(
          "w-1.5 cursor-col-resize hover:bg-blue-500/50 transition-colors flex-shrink-0",
          isResizing && "bg-blue-500/50",
        )}
        onMouseDown={handleMouseDown}
      />
      <div
        className="flex-shrink-0 border-l bg-background flex flex-col h-full"
        style={{ width: `${width}px` }}
      >
        <SecondaryPanelContent thread={thread} />
      </div>
    </>
  );
}

function SecondaryPanelContent({ thread }: { thread?: ThreadInfoFull }) {
  const { secondaryPanelMode } = useSecondaryPanel();
  if (!thread) {
    return null;
  }
  if (secondaryPanelMode === "preview") {
    return <PreviewPanel thread={thread} />;
  }
  return <GitDiffView thread={thread} />;
}
