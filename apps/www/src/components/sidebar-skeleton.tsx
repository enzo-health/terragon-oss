"use client";

import { Skeleton } from "@/components/ui/skeleton";

export function SidebarSkeleton() {
  return (
    <div className="flex h-full w-[280px] flex-col border-r bg-background p-4">
      {/* Header skeleton */}
      <div className="flex items-center justify-between mb-6">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-8 rounded-lg" />
      </div>

      {/* Navigation items skeleton */}
      <div className="space-y-3">
        <Skeleton className="h-9 w-full rounded-lg" />
        <Skeleton className="h-9 w-full rounded-lg" />
        <Skeleton className="h-9 w-full rounded-lg" />
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Footer skeleton */}
      <Skeleton className="h-12 w-full rounded-lg" />
    </div>
  );
}
