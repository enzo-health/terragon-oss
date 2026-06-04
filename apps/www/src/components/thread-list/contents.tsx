"use client";

import { useAtom, useAtomValue } from "jotai";
import { ChevronsDown, ChevronsUp, LoaderCircle } from "lucide-react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import {
  threadListCollapsedSectionsAtom,
  threadListGroupByAtom,
} from "@/atoms/user-cookies";
import { selectedModelAtom } from "@/atoms/user-flags";
import { Button } from "@/components/ui/button";
import type { ThreadListFilters } from "@/queries/thread-queries";
import { BulkActionToolbar } from "./bulk-action-toolbar";
import { EmptyThreadList } from "./empty";
import { CollapsableThreadSection } from "./section";
import { useThreadList } from "./use-thread-list";

const RecommendedTasks = dynamic(
  () => import("../recommended-tasks").then((mod) => mod.RecommendedTasks),
  {
    loading: () => null,
  },
);

const reloadPage = () => {
  window.location.reload();
};

type ThreadListContentsProps = {
  viewFilter: "all" | "active" | "archived";
  queryFilters: ThreadListFilters;
  showSuggestedTasks: boolean;
  setPromptText: (promptText: string) => void;
  allowGroupBy: boolean;
  isSidebar: boolean;
};

export function ThreadListContents({
  viewFilter,
  queryFilters,
  showSuggestedTasks,
  setPromptText,
  allowGroupBy,
  isSidebar,
}: ThreadListContentsProps) {
  const pathname = usePathname();
  const activeThreadId = pathname.startsWith("/task/")
    ? (pathname.slice("/task/".length).split("/")[0] ?? null)
    : null;
  const [collapsedSections, setCollapsedSections] = useAtom(
    threadListCollapsedSectionsAtom,
  );
  const groupBy = useAtomValue(threadListGroupByAtom);
  const effectiveGroupBy = allowGroupBy ? groupBy : "lastUpdated";
  const selectedModel = useAtomValue(selectedModelAtom);

  const { threadGroups, threads, isLoading, isError } = useThreadList({
    viewFilter,
    queryFilters,
    groupBy: effectiveGroupBy,
  });

  const nonEmptyGroups = threadGroups.filter((g) => g.threads.length > 0);
  const allCollapsed =
    nonEmptyGroups.length > 1 &&
    nonEmptyGroups.every((g) => !!collapsedSections[g.id]);
  const toggleAllSections = () => {
    const newState: Record<string, boolean> = {};
    for (const group of nonEmptyGroups) {
      newState[group.id] = !allCollapsed;
    }
    setCollapsedSections((prev) => ({ ...prev, ...newState }));
  };

  const allThreadIds = threads.map((t) => t.id);

  if (isLoading) {
    return (
      <div className="flex flex-col h-full items-center justify-center">
        <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-2">
        <p className="text-sm text-muted-foreground">Failed to load tasks.</p>
        <Button
          variant="outline"
          size="sm"
          onClick={reloadPage}
          className="text-muted-foreground"
        >
          Retry
        </Button>
      </div>
    );
  }
  return (
    <>
      <div className="flex-1 pb-2 flex flex-col gap-2">
        <BulkActionToolbar
          threadIds={allThreadIds}
          viewFilter={viewFilter === "all" ? "active" : viewFilter}
        />
        {nonEmptyGroups.length > 1 && (
          <button
            type="button"
            onClick={toggleAllSections}
            className="text-micro text-muted-foreground hover:text-foreground transition-colors duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] text-left pl-2.5 py-0.5 flex items-center gap-1 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:rounded-sm focus-visible:outline-none"
            title={
              allCollapsed ? "Expand all sections" : "Collapse all sections"
            }
          >
            {allCollapsed ? (
              <ChevronsDown className="size-3" />
            ) : (
              <ChevronsUp className="size-3" />
            )}
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        )}
        <div className="space-y-1">
          {threadGroups.map((group) => (
            <CollapsableThreadSection
              key={group.id}
              title={group.title}
              threads={group.threads}
              isCollapsed={!!collapsedSections[group.id]}
              groupId={group.id}
              activeThreadId={activeThreadId}
              isSidebar={isSidebar}
              groupBy={effectiveGroupBy}
            />
          ))}
        </div>
        {threads.length === 0 && (
          <EmptyThreadList queryFilters={queryFilters} />
        )}
        {viewFilter === "active" && showSuggestedTasks && (
          <div className="space-y-3">
            <h3 className="text-caption uppercase tracking-[0.13em] font-medium text-muted-foreground sticky top-9 bg-sidebar z-10 py-1">
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
}
