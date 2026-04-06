"use client";

import { useLiveQuery, eq } from "@tanstack/react-db";
import {
  getThreadInfoCollection,
  seedThreadList,
} from "@/collections/thread-info-collection";
import { ThreadInfo } from "@terragon/shared/db/types";
import { useRef, useEffect, useMemo } from "react";
import { useInfiniteThreadList } from "@/queries/thread-queries";

/**
 * Reactive thread list: React Query fetches, TanStack DB stores + filters reactively.
 *
 * Components using this hook must be wrapped in dynamic({ ssr: false }) —
 * useLiveQuery requires useSyncExternalStore which needs getServerSnapshot for SSR.
 */
export function useThreadInfoList(filters: {
  archived?: boolean;
  automationId?: string;
}) {
  const { archived, automationId } = filters;

  const {
    data,
    isLoading: isQueryLoading,
    isError,
  } = useInfiniteThreadList({ archived, automationId });
  const threads = useMemo(
    () => data?.pages.flatMap((page) => page) ?? [],
    [data],
  );

  // Seed the local collection whenever React Query delivers data
  useEffect(() => {
    if (threads.length > 0) seedThreadList(threads);
  }, [threads]);

  // Read from the local collection for reactive WebSocket updates
  const collectionRef = useRef(getThreadInfoCollection());
  const collection = collectionRef.current;
  const result = useLiveQuery(
    (q) => {
      let query = q.from({ t: collection });
      if (archived !== undefined)
        query = query.where(({ t }) => eq(t.archived, archived));
      if (automationId !== undefined)
        query = query.where(({ t }) => eq(t.automationId, automationId));
      return query.orderBy(({ t }) => t.updatedAt, "desc");
    },
    [archived, automationId, collection],
  );

  const collectionThreads = (result.data ?? []) as ThreadInfo[];
  const displayThreads =
    collectionThreads.length > 0 ? collectionThreads : threads;

  return {
    threads: displayThreads,
    isLoading: isQueryLoading && collectionThreads.length === 0,
    isError,
  };
}
