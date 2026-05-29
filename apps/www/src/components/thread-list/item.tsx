import type { ThreadInfo } from "@terragon/shared/db/types";
import { useAtomValue, useSetAtom } from "jotai";
import Link from "next/link";
import React, { useState } from "react";
import {
  enterSelectionModeAtom,
  isThreadSelectionModeAtom,
  lastSelectedThreadIdAtom,
  selectedThreadAtom,
  toggleThreadSelectionAtom,
} from "@/atoms/user-cookies";
import { prefetchThreadIntoCollections } from "@/collections/prefetch";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { cn } from "@/lib/utils";
import { DraftTaskDialog } from "../chat/draft-task-dialog";
import { PRStatusPill } from "../pr-status-pill";
import { ThreadAgentIcon } from "../thread-agent-icon";
import { ThreadStatusIndicator } from "../thread-status";
import { Checkbox } from "../ui/checkbox";
import { CreatingIndicator } from "./creating-indicator";
import { InlineNameEditor } from "./inline-name-editor";
import {
  preventDefaultLinkEvent,
  stopCheckboxClickPropagation,
} from "./item-events";
import { LazyThreadListMenu } from "./lazy-thread-list-menu";
import { SmallAutomationIndicator } from "./small-automation-indicator";

type ThreadListItemProps = {
  isActive: boolean;
  thread: ThreadInfo;
  className?: string;
  hideRepository: boolean;
  animationDelayMs?: number;
  allThreadIds?: string[];
};

export function ThreadListItem({
  thread,
  isActive,
  className,
  hideRepository,
  animationDelayMs,
  allThreadIds,
}: ThreadListItemProps) {
  const title = thread.name || "Untitled";
  const relativeTime = formatRelativeTime(thread.updatedAt);
  const isOptimisticThread = thread.id.startsWith("optimistic-");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [isEditingDraft, setIsEditingDraft] = useState(false);

  const isSelected = useAtomValue(selectedThreadAtom(thread.id));
  const isSelectionMode = useAtomValue(isThreadSelectionModeAtom);
  const lastSelectedId = useAtomValue(lastSelectedThreadIdAtom);
  const enterSelectionMode = useSetAtom(enterSelectionModeAtom);
  const toggleThreadSelection = useSetAtom(toggleThreadSelectionAtom);
  const itemStyle: React.CSSProperties = {
    contentVisibility: "auto",
    containIntrinsicSize: "80px",
    transitionBehavior: "allow-discrete",
    ...(animationDelayMs !== undefined
      ? { animationDelay: `${animationDelayMs}ms` }
      : {}),
  };

  const openOrSelectThread = (event: React.MouseEvent) => {
    if (isOptimisticThread) {
      event.preventDefault();
      return;
    }

    // Handle selection mode interactions
    if (isSelectionMode) {
      event.preventDefault();
      event.stopPropagation();

      const isRangeSelect = event.shiftKey && lastSelectedId;
      const threadIds = allThreadIds || [];
      toggleThreadSelection({
        threadId: thread.id,
        range: isRangeSelect ? threadIds : undefined,
      });
      return;
    }

    // Enter selection mode on Ctrl/Cmd+click
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      enterSelectionMode(thread.id);
      return;
    }

    if (!event.defaultPrevented && thread.draftMessage) {
      event.preventDefault();
      setIsEditingDraft(true);
    }
  };

  const toggleSelectionFromCheckbox = () => {
    const isRangeSelect =
      (window as typeof window & { lastClickHadShift?: boolean })
        .lastClickHadShift && lastSelectedId;
    const threadIds = allThreadIds || [];

    toggleThreadSelection({
      threadId: thread.id,
      range: isRangeSelect ? threadIds : undefined,
    });
  };

  const prefetchThread = () => {
    if (!isOptimisticThread && !isSelectionMode) {
      prefetchThreadIntoCollections(thread.id);
    }
  };

  const enterSelectionFromContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    if (!isOptimisticThread && !isSelectionMode) {
      enterSelectionMode(thread.id);
    }
  };

  const closeNameEditor = () => {
    setIsEditingName(false);
  };

  const openNameEditor = () => {
    setIsEditingName(true);
  };

  return (
    <>
      <div
        className={cn(
          "relative group",
          "animate-in fade-in slide-in-from-top-2 duration-300 ease-out",
          isSelected && "ring-2 ring-primary/30 rounded-md",
        )}
        style={itemStyle}
      >
        <Link
          href={`/task/${thread.id}`}
          prefetch={!isOptimisticThread && !isSelectionMode}
          aria-disabled={isOptimisticThread}
          tabIndex={isOptimisticThread ? -1 : undefined}
          className={cn(
            "block rounded-md transition-[background-color,border-color,box-shadow] duration-200 ease-out px-2 py-1 relative pr-8 border focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            isActive && !isSelectionMode
              ? "bg-primary/[0.06] border-transparent before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-full before:bg-primary before:content-['']"
              : "hover:bg-accent/60 border-transparent",
            isMenuOpen && "bg-accent",
            isOptimisticThread && [
              "bg-primary/[0.03] border-primary/15",
              "relative overflow-hidden",
              "cursor-default",
            ],
            isSelectionMode && "cursor-pointer hover:bg-accent",
            isSelected && "bg-primary/[0.05]",
            className,
          )}
          onMouseEnter={prefetchThread}
          onClick={openOrSelectThread}
          onContextMenu={enterSelectionFromContextMenu}
        >
          {/* Subtle progress bar for optimistic threads */}
          {isOptimisticThread && (
            <div className="absolute bottom-0 left-2 right-2 h-[1.5px] bg-primary/10 rounded-full overflow-hidden">
              <div className="h-full bg-primary/50 animate-progress-indeterminate rounded-full" />
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              {/* Selection checkbox */}
              {isSelectionMode && !isOptimisticThread && (
                <div className="flex-shrink-0 size-4">
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={toggleSelectionFromCheckbox}
                    onClick={stopCheckboxClickPropagation}
                  />
                </div>
              )}
              {/* Status indicator (hidden in selection mode) */}
              {(!isSelectionMode || isOptimisticThread) && (
                <div className="size-3.5 flex-shrink-0 flex items-center justify-center">
                  <ThreadStatusIndicator
                    thread={thread}
                    isOptimistic={isOptimisticThread}
                  />
                </div>
              )}
              {isEditingName ? (
                <InlineNameEditor thread={thread} onDone={closeNameEditor} />
              ) : (
                <p
                  className={cn(
                    "text-[13px] flex-1 truncate font-medium leading-snug",
                    isOptimisticThread
                      ? "text-muted-foreground"
                      : "text-foreground",
                  )}
                  title={title}
                >
                  {title}
                </p>
              )}
            </div>
            <div className="flex items-center justify-between gap-2.5">
              <div className="flex items-center gap-1.5 text-micro text-muted-foreground min-w-0">
                <span
                  className="flex-shrink-0"
                  title={new Date(thread.updatedAt).toLocaleString()}
                >
                  {isOptimisticThread ? <CreatingIndicator /> : relativeTime}
                </span>
                {thread.githubRepoFullName && !hideRepository && (
                  <>
                    <span className="flex-shrink-0 opacity-50">·</span>
                    <span
                      className="truncate"
                      title={thread.githubRepoFullName}
                    >
                      {thread.githubRepoFullName}
                    </span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {thread.automationId && (
                  <SmallAutomationIndicator
                    automationId={thread.automationId}
                  />
                )}
                {thread.githubPRNumber && thread.prStatus && (
                  <PRStatusPill
                    status={thread.prStatus}
                    checksStatus={thread.prChecksStatus}
                    prNumber={thread.githubPRNumber}
                    repoFullName={thread.githubRepoFullName}
                  />
                )}
                <div
                  className="text-muted-foreground"
                  title={
                    thread.threadChats[0]?.agent
                      ? `Agent: ${thread.threadChats[0].agent}`
                      : undefined
                  }
                  aria-label={
                    thread.threadChats[0]?.agent
                      ? `Agent: ${thread.threadChats[0].agent}`
                      : "Agent"
                  }
                >
                  <ThreadAgentIcon thread={thread} />
                </div>
              </div>
            </div>
          </div>
        </Link>
        {/* Menu button - hidden in selection mode */}
        {!isSelectionMode && (
          <div
            className={cn(
              "absolute right-0 top-1/2 -translate-y-1/2 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
              isMenuOpen
                ? "opacity-100"
                : "opacity-100 sm:opacity-0 focus-within:opacity-100",
              isOptimisticThread && "pointer-events-none opacity-0",
            )}
            onPointerDown={preventDefaultLinkEvent}
          >
            <LazyThreadListMenu
              thread={thread}
              onRenameClick={openNameEditor}
              onMenuOpenChange={setIsMenuOpen}
            />
          </div>
        )}
      </div>
      {thread.draftMessage && (
        <DraftTaskDialog
          thread={thread}
          open={isEditingDraft}
          onOpenChange={setIsEditingDraft}
        />
      )}
    </>
  );
}
