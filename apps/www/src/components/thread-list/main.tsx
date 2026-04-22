"use client";

import dynamic from "next/dynamic";
import { ThreadInfo } from "@terragon/shared";
import { useCallback, useDeferredValue, useMemo, memo } from "react";
import {
  LoaderCircle,
  ChevronDown,
  ChevronRight,
  ArchiveX,
  WorkflowIcon,
  Inbox,
  Archive,
  SlidersHorizontal,
  List,
} from "lucide-react";
import { useRealtimeThreadMatch } from "@/hooks/useRealtime";
import { BroadcastThreadPatch } from "@terragon/types/broadcast";
import { ThreadListItem } from "./item";
import { isToday, isYesterday, isThisWeek } from "date-fns";
import { tz } from "@date-fns/tz";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SheetOrMenu } from "@/components/ui/sheet-or-menu";
import { ThreadListFilters } from "@/queries/thread-queries";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  threadListCollapsedSectionsAtom,
  toggleThreadListCollapsedSectionAtom,
  timeZoneAtom,
  threadListGroupByAtom,
} from "@/atoms/user-cookies";
import { selectedModelAtom } from "@/atoms/user-flags";
import { cn } from "@/lib/utils";
import { ThreadListGroupBy } from "@/lib/cookies";
import { sortThreadsUpdatedAt } from "@/lib/thread-sorting";
import { useThreadInfoList } from "@/hooks/use-thread-info-list";
import { applyThreadPatchToCollection } from "@/collections/thread-info-collection";
import { applyThreadPatchToListQueries } from "@/queries/thread-patch-cache";
import { useQueryClient } from "@tanstack/react-query";
import { ThreadListContentsClient } from "./thread-list-contents-client";

const RecommendedTasks = dynamic(
  () => import("../recommended-tasks").then((mod) => mod.RecommendedTasks),
  {
    loading: () => null,
  },
);

export const ThreadListHeader = memo(function ThreadListHeader({
  className,
  viewFilter,
  setViewFilter,
  allowGroupBy,
}: {
  className?: string;
  viewFilter: "all" | "active" | "archived";
  setViewFilter: (viewFilter: "active" | "archived") => void;
  allowGroupBy: boolean;
}) {
  const [groupBy, setGroupBy] = useAtom(threadListGroupByAtom);
  return (
    <div
      className={cn(
        "px-4 flex items-center justify-between min-h-12 mb-1",
        "animate-in fade-in duration-300",
        className,
      )}
    >
      <h2 className="font-display font-semibold text-[15px] tracking-[-0.01em] text-foreground">
        Tasks
      </h2>
      <div className="flex items-center gap-1">
        {viewFilter !== "all" && (
          <SheetOrMenu
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-fit px-2 hover:bg-accent rounded-full group flex items-center gap-1.5 transition-colors duration-200"
              >
                {viewFilter === "active" ? (
                  <Inbox className="h-3.5 w-3.5 opacity-70" />
                ) : (
                  <Archive className="h-3.5 w-3.5 opacity-70" />
                )}
                <span className="text-[13px] font-sans font-medium opacity-70">
                  {viewFilter === "active" ? "Inbox" : "Archived"}
                </span>
                <ChevronDown className="size-3 opacity-40 group-hover:opacity-100 transition-opacity" />
              </Button>
            }
            title="Tasks Filter"
            collapseAsDrawer
            getItems={() => [
              {
                type: "label",
                label: "Filter By",
              },
              {
                type: "checkbox",
                label: "Inbox",
                checked: viewFilter === "active",
                onCheckedChange: (checked) => {
                  setViewFilter("active");
                },
              },
              {
                type: "checkbox",
                label: "Archived",
                checked: viewFilter === "archived",
                onCheckedChange: (checked) => {
                  setViewFilter("archived");
                },
              },
            ]}
          />
        )}
        {allowGroupBy && (
          <SheetOrMenu
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 hover:bg-accent rounded-full group flex items-center justify-center transition-colors duration-200"
              >
                <SlidersHorizontal className="h-3.5 w-3.5 opacity-70" />
              </Button>
            }
            title="Group Tasks By"
            collapseAsDrawer
            getItems={() => [
              {
                type: "label",
                label: "Group By",
              },
              {
                type: "checkbox",
                label: "Last Updated",
                checked: groupBy === "lastUpdated",
                onCheckedChange: (checked) => {
                  setGroupBy("lastUpdated");
                },
              },
              {
                type: "checkbox",
                label: "Created At",
                checked: groupBy === "createdAt",
                onCheckedChange: (checked) => {
                  setGroupBy("createdAt");
                },
              },
              {
                type: "checkbox",
                label: "Repository",
                checked: groupBy === "repository",
                onCheckedChange: (checked) => {
                  setGroupBy("repository");
                },
              },
            ]}
          />
        )}
      </div>
    </div>
  );
});

const ThreadListSectionHeader = memo(function ThreadListSectionHeader({
  title,
  numThreads,
  isCollapsed,
  onToggle,
  className,
}: {
  title: string;
  numThreads: number;
  isCollapsed: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <h3
      className={cn(
        "group py-1.5 text-[11px] uppercase tracking-[0.6px] font-semibold text-muted-foreground/70 flex items-center gap-1.5 cursor-pointer select-none hover:text-foreground transition-colors sticky top-0 z-10 bg-background pl-3",
        "animate-in fade-in slide-in-from-left-2 duration-300",
        className,
      )}
      onClick={onToggle}
    >
      {isCollapsed ? (
        <ChevronRight className="size-3 opacity-50" />
      ) : (
        <ChevronDown className="size-3 opacity-50" />
      )}
      {title}
      <span className="text-muted-foreground/50 font-sans text-[10px] font-medium">
        {numThreads}
      </span>
    </h3>
  );
});

const CollapsableThreadSection = memo(function CollapsableThreadSection({
  title,
  threads,
  isCollapsed,
  groupId,
  pathname,
  isSidebar,
  groupBy,
}: {
  title: string;
  threads: ThreadInfo[];
  isCollapsed: boolean;
  groupId: string;
  pathname: string;
  isSidebar: boolean;
  groupBy: ThreadListGroupBy;
}) {
  const toggleCollapsedSection = useSetAtom(
    toggleThreadListCollapsedSectionAtom,
  );
  const onToggle = useCallback(
    () => toggleCollapsedSection(groupId),
    [toggleCollapsedSection, groupId],
  );
  const numThreads = threads.length;
  if (numThreads === 0) {
    return null;
  }
  return (
    <div
      className="mb-6"
      style={{ contentVisibility: "auto", containIntrinsicSize: "320px" }}
    >
      <ThreadListSectionHeader
        title={title}
        numThreads={numThreads}
        isCollapsed={isCollapsed}
        onToggle={onToggle}
        className={isSidebar ? "top-0 pr-3" : undefined}
      />
      {!isCollapsed && (
        <div className={cn("space-y-1.5", isSidebar ? "px-2" : undefined)}>
          {threads.map((thread, index) => (
            <ThreadListItem
              key={thread.id}
              thread={thread}
              pathname={pathname}
              className={cn(
                !isSidebar ? "pl-1" : undefined,
                thread.id.startsWith("optimistic-") &&
                  "animate-in fade-in slide-in-from-top-2 duration-300",
              )}
              hideRepository={groupBy === "repository"}
              style={
                thread.id.startsWith("optimistic-")
                  ? { animationDelay: `${index * 50}ms` }
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
});

function EmptyThreadList({
  queryFilters,
}: {
  queryFilters: ThreadListFilters;
}) {
  if (queryFilters.automationId) {
    return (
      <div className="bg-muted/20 rounded-md p-8 flex flex-col items-center justify-center gap-2">
        <div className="flex items-center gap-2">
          <WorkflowIcon className="size-4 text-muted-foreground/70" />
          <span className="text-sm text-muted-foreground/50">
            No tasks for this automation
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="bg-muted/20 rounded-md p-8 flex flex-col items-center justify-center gap-2">
      <div className="flex items-center gap-2">
        {queryFilters.archived ? (
          <ArchiveX className="size-4 text-muted-foreground/70" />
        ) : (
          <List className="size-4 text-muted-foreground/70" />
        )}
        <span className="text-sm text-muted-foreground/50">
          {queryFilters.archived ? "No archived tasks" : "No tasks"}
        </span>
      </div>
    </div>
  );
}

type ThreadGroup = {
  id: string;
  title: string;
  threads: ThreadInfo[];
};

type ThreadGroups = ThreadGroup[];

function useThreadList({
  viewFilter,
  queryFilters,
  groupBy,
}: {
  viewFilter: "all" | "active" | "archived";
  queryFilters: ThreadListFilters;
  groupBy: ThreadListGroupBy;
}) {
  const [timeZone] = useAtom(timeZoneAtom);
  const queryClient = useQueryClient();

  const {
    threads: collectionThreads,
    isLoading,
    isError,
  } = useThreadInfoList({
    archived: queryFilters.archived,
    automationId: queryFilters.automationId,
  });

  const threads = useMemo(() => {
    return collectionThreads.filter((thread) => {
      if (viewFilter === "active" && thread.archived) return false;
      if (viewFilter === "archived" && !thread.archived) return false;
      return true;
    });
  }, [collectionThreads, viewFilter]);
  const deferredThreads = useDeferredValue(threads);

  const threadGroups = useMemo<ThreadGroups>(() => {
    switch (groupBy) {
      case "repository": {
        const repoGroups: Record<string, ThreadInfo[]> = {};
        for (const thread of deferredThreads) {
          const repoName = thread.githubRepoFullName || "Unknown Repository";
          if (!repoGroups[repoName]) repoGroups[repoName] = [];
          repoGroups[repoName].push(thread);
        }
        return Object.keys(repoGroups)
          .sort()
          .map((repoName) => ({
            id: `repo-${repoName}`,
            title: repoName,
            threads: repoGroups[repoName] || [],
          }));
      }
      case "createdAt":
      case "lastUpdated": {
        const todayGroup: ThreadGroup = {
          id: "today",
          title: "Today",
          threads: [],
        };
        const yesterdayGroup: ThreadGroup = {
          id: "yesterday",
          title: "Yesterday",
          threads: [],
        };
        const thisWeekGroup: ThreadGroup = {
          id: "thisWeek",
          title: "This Week",
          threads: [],
        };
        const olderGroup: ThreadGroup = {
          id: "older",
          title: "Older",
          threads: [],
        };
        const groups = [todayGroup, yesterdayGroup, thisWeekGroup, olderGroup];
        const timeZoneContext = tz(timeZone);
        for (const thread of deferredThreads) {
          const dateToUse = new Date(
            groupBy === "createdAt" ? thread.createdAt : thread.updatedAt,
          );
          if (isToday(dateToUse, { in: timeZoneContext })) {
            todayGroup.threads.push(thread);
          } else if (isYesterday(dateToUse, { in: timeZoneContext })) {
            yesterdayGroup.threads.push(thread);
          } else if (
            isThisWeek(dateToUse, { weekStartsOn: 1, in: timeZoneContext })
          ) {
            thisWeekGroup.threads.push(thread);
          } else {
            olderGroup.threads.push(thread);
          }
        }
        if (groupBy === "lastUpdated") {
          todayGroup.threads = sortThreadsUpdatedAt(todayGroup.threads);
          yesterdayGroup.threads = sortThreadsUpdatedAt(yesterdayGroup.threads);
          thisWeekGroup.threads = sortThreadsUpdatedAt(thisWeekGroup.threads);
          olderGroup.threads = sortThreadsUpdatedAt(olderGroup.threads);
        }
        return groups;
      }
      default: {
        const _exhaustiveCheck: never = groupBy;
        console.error("Unhandled thread list group by:", _exhaustiveCheck);
        return [];
      }
    }
  }, [deferredThreads, timeZone, groupBy]);

  // WebSocket patches write to both TanStack DB (primary) and React Query (legacy)
  const matchThread = useCallback((patch: BroadcastThreadPatch) => {
    if (patch.op === "delete") return true;
    if ((patch.refetch ?? []).includes("list")) return true;
    if (patch.shell) return true;
    return !!(
      patch.chat?.status !== undefined ||
      patch.chat?.errorMessage !== undefined ||
      patch.chat?.agent !== undefined
    );
  }, []);
  const onThreadChange = useCallback(
    (patches: BroadcastThreadPatch[]) => {
      patches.forEach((patch) => {
        applyThreadPatchToCollection(patch);
        applyThreadPatchToListQueries({ queryClient, patch });
      });
    },
    [queryClient],
  );
  useRealtimeThreadMatch({ matchThread, onThreadChange });

  return { threadGroups, threads, isLoading, isError };
}

export const ThreadListContents = memo(function ThreadListContents({
  viewFilter,
  queryFilters,
  showSuggestedTasks,
  setPromptText,
  allowGroupBy,
  isSidebar,
}: {
  viewFilter: "all" | "active" | "archived";
  queryFilters: ThreadListFilters;
  showSuggestedTasks: boolean;
  setPromptText: (promptText: string) => void;
  allowGroupBy: boolean;
  isSidebar: boolean;
}) {
  const pathname = usePathname();
  const collapsedSections = useAtomValue(threadListCollapsedSectionsAtom);
  const groupBy = useAtomValue(threadListGroupByAtom);
  const selectedModel = useAtomValue(selectedModelAtom);
  const { threadGroups, threads, isLoading, isError } = useThreadList({
    viewFilter,
    queryFilters,
    groupBy: allowGroupBy ? groupBy : "lastUpdated",
  });

  if (isLoading) {
    return (
      <div className="flex flex-col h-full items-center justify-center">
        <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex flex-col h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Failed to load tasks. Please try again.
        </p>
      </div>
    );
  }
  return (
    <>
      <div className="flex-1 pb-4 flex flex-col gap-4">
        <div className="space-y-2">
          {threadGroups.map((group) => (
            <CollapsableThreadSection
              key={group.id}
              title={group.title}
              threads={group.threads}
              isCollapsed={!!collapsedSections[group.id]}
              groupId={group.id}
              pathname={pathname}
              isSidebar={isSidebar}
              groupBy={groupBy}
            />
          ))}
        </div>
        {threads.length === 0 && (
          <EmptyThreadList queryFilters={queryFilters} />
        )}
        {viewFilter === "active" && showSuggestedTasks && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground/70 sticky top-9 bg-background z-10 py-1">
              Suggested tasks
            </h3>
            <RecommendedTasks
              onTaskSelect={setPromptText}
              selectedModel={selectedModel}
            />
          </div>
        )}
      </div>
    </>
  );
});

export const ThreadListMain = memo(function ThreadListMain({
  viewFilter,
  queryFilters,
  allowGroupBy,
  showSuggestedTasks = true,
  setPromptText,
}: {
  viewFilter: "all" | "active" | "archived";
  queryFilters: ThreadListFilters;
  allowGroupBy: boolean;
  showSuggestedTasks?: boolean;
  setPromptText: (promptText: string) => void;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const setViewFilter = useCallback(
    (value: "active" | "archived") => {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("archived");
      if (value === "archived") {
        params.set("archived", "true");
      }
      router.push(`${pathname}?${params.toString()}`);
    },
    [searchParams, router, pathname],
  );
  return (
    <div className="flex-1 pb-4 flex flex-col animate-in fade-in duration-500">
      <ThreadListHeader
        className="sticky top-0 bg-background z-20 px-0 "
        viewFilter={viewFilter}
        setViewFilter={setViewFilter}
        allowGroupBy={allowGroupBy}
      />
      <ThreadListContentsClient
        viewFilter={viewFilter}
        queryFilters={queryFilters}
        showSuggestedTasks={showSuggestedTasks}
        setPromptText={setPromptText}
        allowGroupBy={allowGroupBy}
        isSidebar={false}
      />
    </div>
  );
});
