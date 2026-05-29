"use client";

import { tz } from "@date-fns/tz";
import { useQueryClient } from "@tanstack/react-query";
import type { ThreadInfo } from "@terragon/shared/db/types";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import { isThisWeek, isToday, isYesterday } from "date-fns";
import { useAtomValue } from "jotai";
import { useCallback, useDeferredValue, useMemo } from "react";
import { timeZoneAtom } from "@/atoms/user-cookies";
import { applyThreadPatchToCollection } from "@/collections/thread-info-collection";
import type { ThreadListGroupBy } from "@/lib/cookies";
import { sortThreadsUpdatedAt } from "@/lib/thread-sorting";
import { applyThreadPatchToListQueries } from "@/queries/thread-patch-cache";
import type { ThreadListFilters } from "@/queries/thread-queries";
import { useThreadInfoList } from "@/hooks/use-thread-info-list";
import { useRealtimeThreadMatch } from "@/hooks/useRealtime";

type ThreadGroup = {
  id: string;
  title: string;
  threads: ThreadInfo[];
};

type ThreadGroups = ThreadGroup[];

export function useThreadList({
  viewFilter,
  queryFilters,
  groupBy,
}: {
  viewFilter: "all" | "active" | "archived";
  queryFilters: ThreadListFilters;
  groupBy: ThreadListGroupBy;
}) {
  const timeZone = useAtomValue(timeZoneAtom);
  const queryClient = useQueryClient();

  const {
    threads: collectionThreads,
    isLoading,
    isError,
  } = useThreadInfoList({
    archived: queryFilters.archived,
    automationId: queryFilters.automationId,
  });

  const threads = useMemo(
    () =>
      collectionThreads.filter((thread) => {
        if (viewFilter === "active" && thread.archived) return false;
        if (viewFilter === "archived" && !thread.archived) return false;
        return true;
      }),
    [collectionThreads, viewFilter],
  );
  const deferredThreads = useDeferredValue(threads);

  const threadGroups: ThreadGroups = useMemo(() => {
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
  }, [deferredThreads, groupBy, timeZone]);

  const matchThread = useCallback((patch: BroadcastThreadPatch) => {
    if (patch.op === "delete") return true;
    if ((patch.refetch ?? []).includes("list")) return true;
    if (patch.shell) return true;
    return !!(
      patch.chat?.status !== undefined ||
      patch.chat?.errorMessage !== undefined ||
      patch.chat?.agent !== undefined ||
      patch.chat?.updatedAt !== undefined
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
