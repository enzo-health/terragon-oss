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
      <div className="flex flex-col items-center justify-center px-3 py-6 text-center group-data-[collapsible=icon]:hidden">
        <p className="text-xs font-medium text-sidebar-foreground/80 text-balance">
          No tasks yet
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground text-pretty">
          Create one from the dashboard to get started.
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
        aria-expanded={!isCollapsed}
        className={cn(
          "group/repo flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground text-left select-none",
          "transition-colors duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] hover:text-sidebar-foreground hover:bg-sidebar-accent/40",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        )}
        title={repoName}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 flex-shrink-0 text-muted-foreground/70 transition-transform duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] group-hover/repo:text-sidebar-foreground",
            !isCollapsed && "rotate-90",
          )}
        />
        <span className="truncate">{repoName}</span>
        <span className="ml-auto text-[10px] font-medium tabular-nums text-muted-foreground/60 flex-shrink-0">
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
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "group/thread flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-[background-color,color] duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        isActive
          ? "bg-sidebar-accent text-sidebar-primary-foreground font-medium"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
        isOptimistic && "opacity-60 pointer-events-none",
      )}
    >
      <div className="w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center">
        <ThreadStatusIndicator thread={thread} isOptimistic={isOptimistic} />
      </div>
      <span className="truncate leading-snug text-pretty">{title}</span>
    </Link>
  );
}
