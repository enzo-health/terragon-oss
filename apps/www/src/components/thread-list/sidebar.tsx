"use client";

import { PanelLeftClose, SquarePen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type KeyboardEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { cn } from "@/lib/utils";
import { headerClassName } from "../shared/header";
import { ThreadListHeader } from "./header";
import { ThreadListContentsClient } from "./thread-list-contents-client";
import { useCollapsibleThreadList } from "./use-collapsible-thread-list";

const TASK_PANEL_MIN_WIDTH = 280;
const TASK_PANEL_MAX_WIDTH = 600;
const TASK_PANEL_DEFAULT_WIDTH = 251;
const noopSetPromptText = () => {};

export function ThreadListSidebar() {
  const pathname = usePathname();
  const {
    canCollapseThreadList,
    isThreadListCollapsed,
    setThreadListCollapsed,
  } = useCollapsibleThreadList(pathname);
  const isOnDashboard = pathname === "/dashboard";

  const [viewFilter, setViewFilter] = useState<"active" | "archived">("active");
  const queryFilters = { archived: viewFilter === "archived" };

  const { width, isResizing, handleMouseDown } = useResizablePanel({
    minWidth: TASK_PANEL_MIN_WIDTH,
    maxWidth: TASK_PANEL_MAX_WIDTH,
    defaultWidth: TASK_PANEL_DEFAULT_WIDTH,
    mode: "fixed",
    direction: "ltr",
  });
  const panelStyle = { width: `${width}px` };
  const collapseThreadList = () => {
    setThreadListCollapsed(true);
  };
  const handleResizeKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
    }
  };
  if (isThreadListCollapsed) {
    return null;
  }
  return (
    <div
      className="hidden md:flex sticky top-0 h-full border-r bg-background flex-shrink-0 z-20"
      style={panelStyle}
    >
      <div className="flex flex-col h-full w-full overflow-hidden">
        <div
          className={cn("px-2 py-1 flex items-center gap-1.5", headerClassName)}
        >
          {isOnDashboard ? (
            <span className="flex-1 flex items-center gap-2 px-2 text-caption font-medium text-foreground">
              Your tasks
            </span>
          ) : (
            <Link
              href="/dashboard"
              className="flex-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-caption font-medium text-muted-foreground transition-colors duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] hover:bg-accent hover:text-foreground"
            >
              <SquarePen className="size-3.5 text-muted-foreground" />
              <span>New Task</span>
            </Link>
          )}
          {canCollapseThreadList && (
            <Button
              variant="ghost"
              size="icon"
              onClick={collapseThreadList}
              className="size-8 flex-shrink-0 rounded-md hover:bg-accent"
              title="Collapse task list"
            >
              <PanelLeftClose className="size-4 text-muted-foreground" />
            </Button>
          )}
        </div>
        <ThreadListHeader
          viewFilter={viewFilter}
          setViewFilter={setViewFilter}
          allowGroupBy={true}
        />
        <div className="flex-1 overflow-y-auto px-1">
          <ThreadListContentsClient
            viewFilter={viewFilter}
            queryFilters={queryFilters}
            allowGroupBy={true}
            showSuggestedTasks={false}
            setPromptText={noopSetPromptText}
            isSidebar={true}
          />
        </div>
      </div>

      <button
        type="button"
        className={cn(
          "absolute right-0 top-0 h-full w-2 cursor-col-resize hover:bg-accent transition-colors duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] z-30",
          isResizing && "bg-accent",
        )}
        onMouseDown={handleMouseDown}
        aria-label="Resize task list"
        onKeyDown={handleResizeKeyDown}
      />
    </div>
  );
}
