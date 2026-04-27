import { DBMessage, ThreadInfoFull } from "@terragon/shared";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { cn } from "@/lib/utils";
import { type ArtifactWorkspaceItem } from "./secondary-panel-helpers";
import { SecondaryPanelContent } from "./secondary-panel-shell";
import type { PromptBoxRef } from "./thread-context";

const MOBILE_DRAWER_SNAP_POINTS = [0.6, 0.95] as const;
const MOBILE_DRAWER_DEFAULT_SNAP = 0.6;
/**
 * Pixel tolerance for sub-pixel rounding when deciding whether the drawer
 * has more content scrollable below the visible area. Below this threshold
 * we treat the user as already at the bottom and hide the scroll fade.
 */
const SCROLL_FADE_TOLERANCE_PX = 8;

export function MobileArtifactDrawer({
  isOpen,
  onOpenChange,
  artifacts,
  activeArtifactId,
  onActiveArtifactChange,
  onClose,
  thread,
  messages,
  threadChatId,
  isReadOnly,
  promptBoxRef,
  onOptimisticPermissionModeUpdate,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  artifacts: ArtifactWorkspaceItem[];
  activeArtifactId: string | null;
  onActiveArtifactChange: (artifactId: string | null) => void;
  onClose: () => void;
  thread: ThreadInfoFull;
  messages: DBMessage[];
  threadChatId?: string;
  isReadOnly?: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
  onOptimisticPermissionModeUpdate?: (mode: "allowAll" | "plan") => void;
}) {
  const [activeSnap, setActiveSnap] = useState<number | string | null>(
    MOBILE_DRAWER_DEFAULT_SNAP,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollFade, setShowScrollFade] = useState(false);

  const checkScrollable = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      setShowScrollFade(false);
      return;
    }
    const hasMoreBelow =
      el.scrollHeight - el.scrollTop - el.clientHeight >
      SCROLL_FADE_TOLERANCE_PX;
    setShowScrollFade(hasMoreBelow);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    checkScrollable();
    el.addEventListener("scroll", checkScrollable, { passive: true });
    const observer = new ResizeObserver(checkScrollable);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", checkScrollable);
      observer.disconnect();
    };
  }, [checkScrollable]);

  useEffect(() => {
    if (isOpen) {
      setActiveSnap(MOBILE_DRAWER_DEFAULT_SNAP);
    }
  }, [isOpen]);

  return (
    <Drawer
      open={isOpen}
      onOpenChange={onOpenChange}
      snapPoints={[...MOBILE_DRAWER_SNAP_POINTS]}
      activeSnapPoint={activeSnap}
      setActiveSnapPoint={setActiveSnap}
    >
      <DrawerContent
        className="overflow-hidden p-0"
        aria-label="Artifact panel"
      >
        <DrawerHeader className="sr-only">
          <DrawerTitle>Artifact workspace</DrawerTitle>
        </DrawerHeader>
        <div
          ref={scrollRef}
          className={cn(
            "flex-1 min-h-0",
            activeSnap === MOBILE_DRAWER_SNAP_POINTS[1]
              ? "overflow-auto"
              : "overflow-hidden",
          )}
        >
          <SecondaryPanelContent
            artifacts={artifacts}
            activeArtifactId={activeArtifactId}
            onActiveArtifactChange={onActiveArtifactChange}
            onClose={onClose}
            thread={thread}
            messages={messages}
            threadChatId={threadChatId}
            isReadOnly={isReadOnly}
            promptBoxRef={promptBoxRef}
            onOptimisticPermissionModeUpdate={onOptimisticPermissionModeUpdate}
          />
        </div>
        {showScrollFade && (
          <div className="pointer-events-none sticky bottom-0 h-8 bg-gradient-to-t from-background to-transparent" />
        )}
      </DrawerContent>
    </Drawer>
  );
}
