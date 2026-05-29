"use client";

import type { ThreadInfo } from "@terragon/shared/db/types";
import { useSetAtom } from "jotai";
import type { CSSProperties } from "react";
import { toggleThreadListCollapsedSectionAtom } from "@/atoms/user-cookies";
import type { ThreadListGroupBy } from "@/lib/cookies";
import { cn } from "@/lib/utils";
import { ThreadListItem } from "./item";
import { ThreadListSectionHeader } from "./section-header";

const THREAD_SECTION_STYLE = {
  contentVisibility: "auto",
  containIntrinsicSize: "320px",
} satisfies CSSProperties;

const THREAD_SECTION_LIST_STYLE = {
  transitionBehavior: "allow-discrete",
} satisfies CSSProperties;

type CollapsableThreadSectionProps = {
  title: string;
  threads: ThreadInfo[];
  isCollapsed: boolean;
  groupId: string;
  activeThreadId: string | null;
  isSidebar: boolean;
  groupBy: ThreadListGroupBy;
};

export function CollapsableThreadSection({
  title,
  threads,
  isCollapsed,
  groupId,
  activeThreadId,
  isSidebar,
  groupBy,
}: CollapsableThreadSectionProps) {
  const toggleCollapsedSection = useSetAtom(
    toggleThreadListCollapsedSectionAtom,
  );
  const onToggle = () => {
    toggleCollapsedSection(groupId);
  };
  const threadIds = threads.map((t) => t.id);
  const numThreads = threads.length;
  if (numThreads === 0) {
    return null;
  }
  return (
    <div className="mb-2.5" style={THREAD_SECTION_STYLE}>
      <ThreadListSectionHeader
        title={title}
        numThreads={numThreads}
        isCollapsed={isCollapsed}
        onToggle={onToggle}
        className={isSidebar ? "top-0 pr-3" : undefined}
      />
      {!isCollapsed && (
        <div
          className={cn(
            "flex flex-col gap-0.5",
            isSidebar ? "px-1" : undefined,
          )}
          style={THREAD_SECTION_LIST_STYLE}
        >
          {threads.map((thread, index) => (
            <ThreadListItem
              key={thread.id}
              thread={thread}
              isActive={activeThreadId === thread.id}
              className={cn(
                !isSidebar ? "pl-1" : undefined,
                thread.id.startsWith("optimistic-") &&
                  "animate-in fade-in slide-in-from-top-2 duration-300",
              )}
              hideRepository={groupBy === "repository"}
              animationDelayMs={
                thread.id.startsWith("optimistic-") ? index * 50 : undefined
              }
              allThreadIds={threadIds}
            />
          ))}
        </div>
      )}
    </div>
  );
}
