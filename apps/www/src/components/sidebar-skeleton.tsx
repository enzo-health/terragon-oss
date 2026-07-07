"use client";

import { Skeleton } from "@/components/ui/skeleton";

export function SidebarSkeleton() {
  return (
    <div className="flex h-full w-56 flex-col bg-app-background">
      <div className="flex h-12 items-center justify-between px-1.5">
        <Skeleton className="h-6 w-28 rounded-md" />
        <Skeleton className="size-8 rounded-md" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-1.5 pb-2">
        <div className="px-1 pt-1">
          <Skeleton className="h-8 w-full rounded-md" />
        </div>

        <div className="px-1 pb-1 pt-0.5">
          <Skeleton className="h-8 w-full rounded-md" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-1 pt-0">
          <div className="mb-1 flex h-5 items-center px-2">
            <Skeleton className="h-2.5 w-10 rounded" />
          </div>

          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <Skeleton className="size-3 rounded" />
            <Skeleton className="h-2.5 w-20 rounded" />
            <Skeleton className="ml-auto size-2.5 rounded" />
          </div>

          <div className="flex flex-col gap-0.5 px-1 pb-1">
            {SIDEBAR_SKELETON_THREAD_ROWS.map((row) => (
              <div
                key={row}
                className="flex items-center gap-2 px-2 py-1.5 pr-8"
              >
                <Skeleton className="size-3.5 flex-shrink-0 rounded-full" />
                <Skeleton className="h-3 w-3/4 rounded" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-0.5 border-t border-sidebar-border/70 px-2 pb-1.5 pt-1.5">
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="h-10 w-full rounded-md" />
      </div>
    </div>
  );
}

const SIDEBAR_SKELETON_THREAD_ROWS = [0, 1, 2, 3, 4];
