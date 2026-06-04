"use client";

import { useAtom } from "jotai";
import { Archive, ChevronDown, Inbox, SlidersHorizontal } from "lucide-react";
import { threadListGroupByAtom } from "@/atoms/user-cookies";
import { Button } from "@/components/ui/button";
import {
  SheetOrMenu,
  type SheetOrMenuItem,
} from "@/components/ui/sheet-or-menu";
import { cn } from "@/lib/utils";

type ThreadListHeaderProps = {
  className?: string;
  viewFilter: "all" | "active" | "archived";
  setViewFilter: (viewFilter: "active" | "archived") => void;
  allowGroupBy: boolean;
};

export function ThreadListHeader({
  className,
  viewFilter,
  setViewFilter,
  allowGroupBy,
}: ThreadListHeaderProps) {
  const [groupBy, setGroupBy] = useAtom(threadListGroupByAtom);
  const getFilterItems = (): SheetOrMenuItem[] => [
    {
      type: "label",
      label: "Filter By",
    },
    {
      type: "checkbox",
      label: "Inbox",
      checked: viewFilter === "active",
      onCheckedChange: () => {
        setViewFilter("active");
      },
    },
    {
      type: "checkbox",
      label: "Archived",
      checked: viewFilter === "archived",
      onCheckedChange: () => {
        setViewFilter("archived");
      },
    },
  ];
  const getGroupByItems = (): SheetOrMenuItem[] => [
    {
      type: "label",
      label: "Group By",
    },
    {
      type: "checkbox",
      label: "Last Updated",
      checked: groupBy === "lastUpdated",
      onCheckedChange: () => {
        setGroupBy("lastUpdated");
      },
    },
    {
      type: "checkbox",
      label: "Created At",
      checked: groupBy === "createdAt",
      onCheckedChange: () => {
        setGroupBy("createdAt");
      },
    },
    {
      type: "checkbox",
      label: "Repository",
      checked: groupBy === "repository",
      onCheckedChange: () => {
        setGroupBy("repository");
      },
    },
  ];
  return (
    <div
      className={cn(
        "px-2.5 flex items-center justify-between min-h-8",
        "animate-in fade-in duration-[var(--duration-slow)]",
        className,
      )}
    >
      <h2 className="font-semibold text-xs uppercase tracking-[0.06em] text-muted-foreground">
        Tasks
      </h2>
      <div className="flex items-center gap-1">
        {viewFilter !== "all" && (
          <SheetOrMenu
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-fit px-2 hover:bg-accent rounded-md group flex items-center gap-1.5 transition-colors duration-[var(--duration-quick)] ease-[var(--ease-emphasis)]"
                title="Filter tasks"
              >
                {viewFilter === "active" ? (
                  <Inbox className="size-3.5 text-muted-foreground" />
                ) : (
                  <Archive className="size-3.5 text-muted-foreground" />
                )}
                <span className="text-xs font-sans font-medium text-muted-foreground">
                  {viewFilter === "active" ? "Inbox" : "Archived"}
                </span>
                <ChevronDown className="size-3 text-muted-foreground group-hover:text-foreground transition-colors duration-[var(--duration-quick)] ease-[var(--ease-emphasis)]" />
              </Button>
            }
            title="Tasks Filter"
            collapseAsDrawer
            getItems={getFilterItems}
          />
        )}
        {allowGroupBy && (
          <SheetOrMenu
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className="size-7 hover:bg-accent rounded-md group flex items-center justify-center transition-colors duration-[var(--duration-quick)] ease-[var(--ease-emphasis)]"
                title="Group tasks by"
              >
                <SlidersHorizontal className="size-3.5 text-muted-foreground" />
              </Button>
            }
            title="Group Tasks By"
            collapseAsDrawer
            getItems={getGroupByItems}
          />
        )}
      </div>
    </div>
  );
}
