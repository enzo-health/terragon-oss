"use client";

import { ThreadInfo } from "@terragon/shared";
import { useCallback, useMemo, memo } from "react";
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
import { RecommendedTasks } from "../recommended-tasks";
import {
  ThreadListFilters,
  useInfiniteThreadList,
} from "@/queries/thread-queries";
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
import { useQueryClient } from "@tanstack/react-query";
import { applyThreadPatchToListQueries } from "@/queries/thread-patch-cache";

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
        "px-4 flex items-center justify-between min-h-8",
        className,
      )}
    >
      <h2 className="font-semibold text-sm">Tasks</h2>
      <div className="flex items-center gap-0.5">
        {viewFilter !== "all" && (
          <SheetOrMenu
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-fit px-1 hover:bg-sidebar-accent/50 group flex items-center gap-1"
              >
                {viewFilter === "active" ? (
                  <Inbox className="h-3.5 w-3.5" />
                ) : (
                  <Archive className="h-3.5 w-3.5" />
                )}
                <ChevronDown className="size-3 opacity-50" />
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
                className="h-8 w-fit px-1 hover:bg-sidebar-accent/50 group flex items-center gap-1"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
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
        "group py-1 text-xs font-medium text-muted-foreground flex items-center gap-1 cursor-pointer select-none hover:text-foreground transition-colors sticky top-[28px] z-30 bg-background pl-0.5",
        className,
      )}
      onClick={onToggle}
    >
      {isCollapsed ? (
        <ChevronRight className="size-3 opacity-50 transition-opacity" />
      ) : (
        <ChevronDown className="size-3 opacity-50 sm:opacity-0 group-hover:opacity-50 transition-opacity" />
      )}
      {title}
      <span className="text-muted-foreground/50">({numThreads})</span>
    </h3>
  );
});

const CollapsableThreadSection = memo(function CollapsableThreadSection({
  title,
  threads,
  isCollapsed,
  onToggle,
  pathname,
  isSidebar,
  groupBy,
}: {
  title: string;
  threads: ThreadInfo[];
  isCollapsed: boolean;
  onToggle: () => void;
  pathname: string;
  isSidebar: boolean;
  groupBy: ThreadListGroupBy;
}) {
  const numThreads = threads.length;
  if (numThreads === 0) {
    return null;
  }
  return (
    <div className="space-y-1">
      <ThreadListSectionHeader
        title={title}
        numThreads={numThreads}
        isCollapsed={isCollapsed}
        onToggle={onToggle}
        className={isSidebar ? "top-0 pr-3 bg-sidebar" : undefined}
      />
      {!isCollapsed && (
        <div className={cn("space-y-0.5", isSidebar ? "px-2" : undefined)}>
          {threads.map((thread) => (
            <ThreadListItem
              key={thread.id}
              thread={thread}
              pathname={pathname}
              className={!isSidebar ? "pl-1" : undefined}
              hideRepository={groupBy === "repository"}
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
    data,
    isLoading,
    isError,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteThreadList(queryFilters);
  const threads = useMemo(
    () => data?.pages.flatMap((page) => page) ?? [],
    [data],
  );
  const { threadGroups, threadIds } = useMemo<{
    threadGroups: ThreadGroups;
    threadIds: Set<string>;
  }>(() => {
    const seenThreadIds = new Set<string>();
    const filteredThreads = threads.filter((thread) => {
      if (viewFilter === "active" && thread.archived) {
        return false;
      }
      if (viewFilter === "archived" && !thread.archived) {
        return false;
      }
      if (!seenThreadIds.has(thread.id)) {
        seenThreadIds.add(thread.id);
        return true;
      }
      return false;
    });
    switch (groupBy) {
      case "repository": {
        // Group by repository
        const repoGroups: Record<string, ThreadInfo[]> = {};
        for (const thread of filteredThreads) {
          const repoName = thread.githubRepoFullName || "Unknown Repository";
          if (!repoGroups[repoName]) {
            repoGroups[repoName] = [];
          }
          repoGroups[repoName].push(thread);
        }

        // Sort repositories alphabetically
        const sortedRepoNames = Object.keys(repoGroups).sort();
        const threadGroups: ThreadGroup[] = [];
        for (const repoName of sortedRepoNames) {
          threadGroups.push({
            id: `repo-${repoName}`,
            title: repoName,
            threads: repoGroups[repoName] || [],
          });
        }
        return {
          threadGroups,
          threadIds: seenThreadIds,
        };
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
        const threadGroups: ThreadGroup[] = [
          todayGroup,
          yesterdayGroup,
          thisWeekGroup,
          olderGroup,
        ];
        for (const thread of filteredThreads) {
          const dateToUse = new Date(
            groupBy === "createdAt" ? thread.createdAt : thread.updatedAt,
          );
          if (isToday(dateToUse, { in: tz(timeZone) })) {
            todayGroup.threads.push(thread);
          } else if (isYesterday(dateToUse, { in: tz(timeZone) })) {
            yesterdayGroup.threads.push(thread);
          } else if (
            isThisWeek(dateToUse, { weekStartsOn: 1, in: tz(timeZone) })
          ) {
            thisWeekGroup.threads.push(thread);
          } else {
            olderGroup.threads.push(thread);
          }
        }
        // Apply stable sorting to each group if grouping by last updated
        if (groupBy === "lastUpdated") {
          todayGroup.threads = sortThreadsUpdatedAt(todayGroup.threads);
          yesterdayGroup.threads = sortThreadsUpdatedAt(yesterdayGroup.threads);
          thisWeekGroup.threads = sortThreadsUpdatedAt(thisWeekGroup.threads);
          olderGroup.threads = sortThreadsUpdatedAt(olderGroup.threads);
        }
        return {
          threadGroups,
          threadIds: seenThreadIds,
        };
      }
      default: {
        const _exhaustiveCheck: never = groupBy;
        console.error("Unhandled thread list group by:", _exhaustiveCheck);
        return {
          threadGroups: [],
          threadIds: seenThreadIds,
        };
      }
    }
  }, [threads, viewFilter, timeZone, groupBy]);

  const showArchived = viewFilter === "archived";
  const automationId = queryFilters.automationId;
  const matchThread = useCallback(
    (patch: BroadcastThreadPatch) => {
      const hasListVisibleChatChange =
        patch.chat?.status !== undefined ||
        patch.chat?.errorMessage !== undefined ||
        patch.chat?.agent !== undefined;
      if (
        !patch.shell &&
        !hasListVisibleChatChange &&
        !(patch.refetch ?? []).includes("list")
      ) {
        return false;
      }
      if (threadIds.has(patch.threadId)) {
        return true;
      }
      if (patch.op === "delete") {
        return true;
      }
      if ((patch.refetch ?? []).includes("list")) {
        return true;
      }
      if (automationId && patch.shell?.automationId !== automationId) {
        return false;
      }
      if (patch.shell?.archived !== undefined) {
        return showArchived === patch.shell.archived;
      }
      return patch.op === "upsert";
    },
    [threadIds, showArchived, automationId],
  );
  useRealtimeThreadMatch({
    matchThread,
    onThreadChange: (patches) => {
      patches.forEach((patch) => {
        applyThreadPatchToListQueries({ queryClient, patch });
      });
    },
  });
  return {
    threadGroups,
    threads,
    hasNextPage,
    isLoading,
    isError,
    fetchNextPage,
    isFetchingNextPage,
  };
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
  const toggleCollapsedSection = useSetAtom(
    toggleThreadListCollapsedSectionAtom,
  );
  const groupBy = useAtomValue(threadListGroupByAtom);
  const selectedModel = useAtomValue(selectedModelAtom);
  const {
    threadGroups,
    threads,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useThreadList({
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
              onToggle={() => toggleCollapsedSection(group.id)}
              pathname={pathname}
              isSidebar={isSidebar}
              groupBy={groupBy}
            />
          ))}
        </div>
        {threads.length === 0 && (
          <EmptyThreadList queryFilters={queryFilters} />
        )}
        {hasNextPage && threads.length > 0 && (
          <div
            className={cn(
              "flex justify-center",
              isSidebar ? "px-2" : undefined,
            )}
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="w-full"
            >
              {isFetchingNextPage ? (
                <>
                  <LoaderCircle className="size-3 animate-spin mr-2" />
                  Loading...
                </>
              ) : (
                "Load more"
              )}
            </Button>
          </div>
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
  return (
    <>
      <div className="flex-1 pb-4 flex flex-col">
        <ThreadListHeader
          className="sticky top-0 bg-background z-20 px-0 "
          viewFilter={viewFilter}
          setViewFilter={(value) => {
            const params = new URLSearchParams(searchParams.toString());
            params.delete("archived");
            if (value === "archived") {
              params.set("archived", "true");
            }
            router.push(`${pathname}?${params.toString()}`);
          }}
          allowGroupBy={allowGroupBy}
        />
        <ThreadListContents
          viewFilter={viewFilter}
          queryFilters={queryFilters}
          showSuggestedTasks={showSuggestedTasks}
          setPromptText={setPromptText}
          allowGroupBy={allowGroupBy}
          isSidebar={false}
        />
      </div>
    </>
  );
});
