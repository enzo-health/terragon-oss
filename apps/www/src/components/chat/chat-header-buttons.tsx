"use client";

import { DBUserMessage, ThreadInfoFull } from "@terragon/shared";
import { AIAgent } from "@terragon/agent/types";
import { useState, memo } from "react";
import { MoreHorizontal } from "lucide-react";
import { PanelRight, PanelBottom } from "@/components/icons/panels";
import { Button } from "../ui/button";
import { useIsSmallScreen } from "@/hooks/useMediaQuery";
import { ThreadMenuDropdown } from "../thread-menu-dropdown";
import { useSecondaryPanel } from "./hooks";
import { ARTIFACT_WORKSPACE_PANEL_ID } from "./secondary-panel";
import { CodeButton } from "./chat-header-code-button";
import { ShareButton } from "./chat-header-share-button";
import { ShareDrawer } from "./chat-header-share-drawer";

export const ChatHeaderButtons = memo(function ChatHeaderButtons({
  thread,
  threadAgent,
  redoDialogData,
  onRenameClick,
  isReadOnly = false,
  onTerminalClick,
}: {
  thread: ThreadInfoFull;
  threadAgent: AIAgent;
  redoDialogData?: {
    threadId: string;
    repoFullName: string;
    repoBaseBranchName: string;
    disableGitCheckpointing: boolean;
    skipSetup: boolean;
    permissionMode: "allowAll" | "plan";
    initialUserMessage: DBUserMessage;
  };
  onRenameClick: () => void;
  isReadOnly?: boolean;
  onTerminalClick?: () => void;
}) {
  const isSmallScreen = useIsSmallScreen();
  const [shareDrawerOpen, setShareDrawerOpen] = useState(false);
  const { isSecondaryPanelOpen, setIsSecondaryPanelOpen } = useSecondaryPanel();

  const handleShareClick = () => {
    setShareDrawerOpen(true);
  };

  return (
    <>
      <div className="flex gap-2 sm:gap-2.5 items-center">
        {(!isReadOnly || isSmallScreen) && (
          <ThreadMenuDropdown
            thread={thread}
            redoDialogData={redoDialogData}
            trigger={
              <Button variant="ghost" size="icon" aria-label="More options">
                <MoreHorizontal className="size-4" />
              </Button>
            }
            onRenameClick={onRenameClick}
            onShareClick={handleShareClick}
            onTerminalClick={onTerminalClick}
            showRedoTaskAction={!isReadOnly}
            showPullRequestActions
            showRenameAction={!isReadOnly}
            showShareAction={true}
            isReadOnly={isReadOnly}
          />
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setIsSecondaryPanelOpen(!isSecondaryPanelOpen)}
          aria-label="Toggle artifact workspace"
          aria-expanded={isSecondaryPanelOpen}
          aria-controls={ARTIFACT_WORKSPACE_PANEL_ID}
          aria-haspopup={isSmallScreen ? "dialog" : undefined}
        >
          {isSmallScreen ? (
            <PanelBottom
              className="size-4"
              isOpen={isSecondaryPanelOpen}
              aria-hidden="true"
            />
          ) : (
            <PanelRight
              className="size-4"
              isOpen={isSecondaryPanelOpen}
              aria-hidden="true"
            />
          )}
        </Button>
        {!isReadOnly && !isSmallScreen && (
          <CodeButton thread={thread} agent={threadAgent} />
        )}
        {/* Hide ShareButton on mobile */}
        {!isSmallScreen && (
          <ShareButton thread={thread} isReadOnly={isReadOnly} />
        )}
      </div>

      {/* Share Drawer for mobile */}
      <ShareDrawer
        thread={thread}
        open={shareDrawerOpen}
        onOpenChange={setShareDrawerOpen}
        isReadOnly={isReadOnly}
      />
    </>
  );
});
