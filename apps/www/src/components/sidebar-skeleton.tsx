"use client";

import { Skeleton } from "@/components/ui/skeleton";

export function SidebarSkeleton() {
  return (
    <div className="flex h-full w-56 flex-col bg-app-background p-1.5">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-20 rounded-md" />
        <Skeleton className="size-8 rounded-md" />
      </div>

      <div className="mt-2 flex flex-col gap-1 px-1.5">
        <Skeleton className="h-8 w-full rounded-md" />
        <Skeleton className="mt-0.5 h-8 w-full rounded-md" />
        <Skeleton className="mt-2 mb-1 h-3 w-12 rounded" />
        <div className="flex flex-col gap-0.5">
          <Skeleton className="h-7 w-full rounded-md" />
          <Skeleton className="h-7 w-full rounded-md" />
          <Skeleton className="h-7 w-full rounded-md" />
        </div>
      </div>

      <div className="flex-1" />

      <div className="flex flex-col gap-1 px-0.5">
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-9 w-full rounded-md" />
      </div>
    </div>
  );
}
