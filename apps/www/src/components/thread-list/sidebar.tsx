"use client";

import { cn } from "@/lib/utils";
import Link from "next/link";
import { useState } from "react";
import { SquarePen, PanelLeftClose } from "lucide-react";
import { ThreadListHeader } from "./main";
import { ThreadListContentsClient } from "./thread-list-contents-client";
import { Button } from "@/components/ui/button";
import { useCollapsibleThreadList } from "./use-collapsible-thread-list";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { headerClassName } from "../shared/header";

const TASK_PANEL_MIN_WIDTH = 280;
const TASK_PANEL_MAX_WIDTH = 600;
const TASK_PANEL_DEFAULT_WIDTH = 320;

export function ThreadListSidebar() {
  const {
    canCollapseThreadList,
    isThreadListCollapsed,
    setThreadListCollapsed,
  } = useCollapsibleThreadList();

  const [viewFilter, setViewFilter] = useState<"active" | "archived">("active");

  const { width, isResizing, handleMouseDown } = useResizablePanel({
    minWidth: TASK_PANEL_MIN_WIDTH,
    maxWidth: TASK_PANEL_MAX_WIDTH,
    defaultWidth: TASK_PANEL_DEFAULT_WIDTH,
    mode: "fixed",
    direction: "ltr",
  });
  if (isThreadListCollapsed) {
    return null;
  }
  return (
    <div
      className="hidden md:flex sticky top-0 h-screen border-r bg-background flex-shrink-0 z-20"
      style={{ width: `${width}px` }}
    >
      <div className="flex flex-col h-full w-full overflow-hidden">
        <div
          className={cn("px-3 py-2.5 flex items-center gap-2", headerClassName)}
        >
          <Link
            href="/dashboard"
            className="flex-1 flex items-center gap-2 rounded-lg transition-colors duration-150 hover:bg-accent border border-border/40 py-1.5 px-3 text-[13px] font-medium"
          >
            <SquarePen className="h-3.5 w-3.5 opacity-60" />
            <span>New Task</span>
          </Link>
          {canCollapseThreadList && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setThreadListCollapsed(true)}
              className="h-8 w-8 flex-shrink-0 rounded-lg hover:bg-accent"
              title="Collapse task list"
            >
              <PanelLeftClose className="h-4 w-4 opacity-60" />
            </Button>
          )}
        </div>
        <ThreadListHeader
          viewFilter={viewFilter}
          setViewFilter={setViewFilter}
          allowGroupBy={true}
        />
        <div className="flex-1 overflow-y-auto px-1.5">
          <ThreadListContentsClient
            viewFilter={viewFilter}
            queryFilters={{ archived: viewFilter === "archived" }}
            allowGroupBy={true}
            showSuggestedTasks={false}
            setPromptText={() => {}}
            isSidebar={true}
          />
        </div>
      </div>

      {/* Resize handle — 2px visual, wider hit target via padding */}
      <div
        className={cn(
          "absolute right-0 top-0 h-full w-2 cursor-col-resize hover:bg-accent transition-colors z-30",
          isResizing && "bg-accent",
        )}
        onMouseDown={handleMouseDown}
      />
    </div>
  );
}
