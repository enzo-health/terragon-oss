"use client";

import { lazy, Suspense, useSyncExternalStore } from "react";
import { LoaderCircle } from "lucide-react";
import type { ThreadListFilters } from "@/queries/thread-queries";

type ThreadListContentsClientProps = {
  viewFilter: "all" | "active" | "archived";
  queryFilters: ThreadListFilters;
  showSuggestedTasks: boolean;
  setPromptText: (promptText: string) => void;
  allowGroupBy: boolean;
  isSidebar: boolean;
};

const ThreadListContents = lazy(() =>
  import("./contents").then((mod) => ({ default: mod.ThreadListContents })),
);

const subscribeToClientSnapshot = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

function ThreadListLoading() {
  return (
    <div className="flex flex-col h-full items-center justify-center py-8">
      <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * Client-only wrapper for ThreadListContents.
 *
 * ThreadListContents uses useLiveQuery (TanStack DB) which internally calls
 * useSyncExternalStore without getServerSnapshot. Next.js SSR requires this
 * third argument. Until TanStack DB ships SSR support (tracked: TanStack/db#1016),
 * render a loader on the server and mount the live list on the client.
 *
 * The rest of the page (sidebar shell, header, layout) still SSRs normally.
 */
export function ThreadListContentsClient(props: ThreadListContentsClientProps) {
  const isMounted = useSyncExternalStore(
    subscribeToClientSnapshot,
    getClientSnapshot,
    getServerSnapshot,
  );

  if (!isMounted) {
    return <ThreadListLoading />;
  }

  return (
    <Suspense fallback={<ThreadListLoading />}>
      <ThreadListContents {...props} />
    </Suspense>
  );
}
