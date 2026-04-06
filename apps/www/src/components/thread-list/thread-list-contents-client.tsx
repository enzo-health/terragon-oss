"use client";

import dynamic from "next/dynamic";
import { LoaderCircle } from "lucide-react";

/**
 * Client-only wrapper for ThreadListContents.
 *
 * ThreadListContents uses useLiveQuery (TanStack DB) which internally calls
 * useSyncExternalStore without getServerSnapshot. Next.js SSR requires this
 * third argument. Until TanStack DB ships SSR support (tracked: TanStack/db#1016),
 * we use dynamic({ ssr: false }) to skip SSR for this subtree only.
 *
 * The rest of the page (sidebar shell, header, layout) still SSRs normally.
 */
export const ThreadListContentsClient = dynamic(
  () => import("./main").then((mod) => ({ default: mod.ThreadListContents })),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-col h-full items-center justify-center py-8">
        <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
      </div>
    ),
  },
);
