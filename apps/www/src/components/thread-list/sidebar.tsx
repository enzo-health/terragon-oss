"use client";

import { cn } from "@/lib/utils";
import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { SquarePen, PanelLeftClose } from "lucide-react";
import { ThreadListHeader } from "./main";
import { ThreadListContentsClient } from "./thread-list-contents-client";
import { Button } from "@/components/ui/button";
import { useCollapsibleThreadList } from "./use-collapsible-thread-list";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { headerClassName } from "../shared/header";

const TASK_PANEL_MIN_WIDTH = 280;
const TASK_PANEL_MAX_WIDTH = 600;
const TASK_PANEL_DEFAULT_WIDTH = 251;

export function ThreadListSidebar() {
  const {
    canCollapseThreadList,
    isThreadListCollapsed,
    setThreadListCollapsed,
  } = useCollapsibleThreadList();
  const pathname = usePathname();
  const isOnDashboard = pathname === "/dashboard";

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
      className="hidden md:flex sticky top-0 h-full border-r bg-background flex-shrink-0 z-20"
      style={{ width: `${width}px` }}
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
              className="flex-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-caption font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
            >
              <SquarePen className="h-3.5 w-3.5 text-muted-foreground" />
              <span>New Task</span>
            </Link>
          )}
          {canCollapseThreadList && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setThreadListCollapsed(true)}
              className="size-8 flex-shrink-0 rounded-md hover:bg-accent"
              title="Collapse task list"
            >
              <PanelLeftClose className="h-4 w-4 text-muted-foreground" />
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
            queryFilters={{ archived: viewFilter === "archived" }}
            allowGroupBy={true}
            showSuggestedTasks={false}
            setPromptText={() => {}}
            isSidebar={true}
          />
        </div>
      </div>

      <div
        className={cn(
          "absolute right-0 top-0 h-full w-2 cursor-col-resize hover:bg-accent transition-colors z-30",
          isResizing && "bg-accent",
        )}
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize task list"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
          }
        }}
      />
    </div>
  );
}
