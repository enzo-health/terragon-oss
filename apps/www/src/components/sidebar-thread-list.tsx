"use client";

import { useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
import { ThreadInfo } from "@terragon/shared";
import { LoaderCircle, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useThreadInfoList } from "@/hooks/use-thread-info-list";
import { sortThreadsUpdatedAt } from "@/lib/thread-sorting";
import Link from "next/link";
import { getThreadTitle } from "@/agent/thread-utils";
import { ThreadStatusIndicator } from "./thread-status";
import { useAtom, useSetAtom } from "jotai";
import {
  threadListCollapsedSectionsAtom,
  toggleThreadListCollapsedSectionAtom,
} from "@/atoms/user-cookies";

export function SidebarThreadList() {
  const { threads, isLoading, isError } = useThreadInfoList({
    archived: false,
  });

  const repoGroups = useMemo(() => {
    const groups: Record<string, ThreadInfo[]> = {};
    for (const thread of threads) {
      const repoName = thread.githubRepoFullName || "Local Tasks";
      if (!groups[repoName]) groups[repoName] = [];
      groups[repoName].push(thread);
    }
    return Object.keys(groups)
      .sort()
      .map((repoName) => ({
        repoName,
        threads: sortThreadsUpdatedAt(groups[repoName] || []),
      }));
  }, [threads]);

  if (isLoading) {
    return (
      <div className="flex flex-col h-full items-center justify-center py-8">
        <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-2 py-8">
        <p className="text-xs text-muted-foreground">Failed to load tasks.</p>
      </div>
    );
  }

  if (repoGroups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
        <p className="text-xs text-muted-foreground">No tasks yet.</p>
        <p className="text-[10px] text-muted-foreground/70 mt-1">
          Create a task to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {repoGroups.map((group) => (
        <RepoSection
          key={group.repoName}
          repoName={group.repoName}
          threads={group.threads}
        />
      ))}
    </div>
  );
}

function RepoSection({
  repoName,
  threads,
}: {
  repoName: string;
  threads: ThreadInfo[];
}) {
  const [collapsedSections] = useAtom(threadListCollapsedSectionsAtom);
  const toggleCollapsed = useSetAtom(toggleThreadListCollapsedSectionAtom);

  const groupId = `repo-${repoName}`;
  const isCollapsed = !!collapsedSections[groupId];

  const handleToggle = useCallback(() => {
    toggleCollapsed(groupId);
  }, [toggleCollapsed, groupId]);

  return (
    <div className="flex flex-col group-data-[collapsible=icon]:hidden">
      <button
        onClick={handleToggle}
        className={cn(
          "flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground",
          "hover:text-foreground transition-colors text-left select-none",
          "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:rounded-sm focus-visible:outline-none",
        )}
        title={repoName}
      >
        <ChevronRight
          className={cn(
            "size-3 flex-shrink-0 text-muted-foreground transition-transform duration-200 ease-[var(--ease-standard)]",
            !isCollapsed && "rotate-90",
          )}
        />
        <span className="truncate">{repoName}</span>
        <span className="text-muted-foreground/60 text-[10px] font-medium tabular-nums flex-shrink-0 ml-auto">
          {threads.length}
        </span>
      </button>
      {!isCollapsed && (
        <div className="flex flex-col gap-0.5 px-1 pb-1">
          {threads.map((thread) => (
            <SidebarThreadItem key={thread.id} thread={thread} />
          ))}
        </div>
      )}
    </div>
  );
}

function SidebarThreadItem({ thread }: { thread: ThreadInfo }) {
  const pathname = usePathname();
  const isActive = pathname === `/task/${thread.id}`;
  const title = useMemo(() => getThreadTitle(thread), [thread]);
  const isOptimistic = thread.id.startsWith("optimistic-");

  return (
    <Link
      href={`/task/${thread.id}`}
      prefetch={!isOptimistic}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors relative",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        isActive
          ? "bg-sidebar-accent text-sidebar-primary-foreground font-medium before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-full before:bg-sidebar-primary"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
        isOptimistic && "opacity-60 cursor-default",
      )}
    >
      <div className="w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center">
        <ThreadStatusIndicator thread={thread} isOptimistic={isOptimistic} />
      </div>
      <span className="truncate leading-snug">{title}</span>
    </Link>
  );
}
