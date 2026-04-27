"use client";

import { Skeleton } from "@/components/ui/skeleton";

export function ChatUISkeleton() {
  return (
    <div className="flex h-full flex-col">
      {/* Header skeleton */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-lg" />
          <Skeleton className="h-8 w-8 rounded-lg" />
        </div>
      </div>

      {/* Chat area skeleton */}
      <div className="flex-1 p-4 space-y-4">
        <Skeleton className="h-16 w-[85%] rounded-lg" />
        <Skeleton className="h-24 w-[75%] rounded-lg" />
        <Skeleton className="h-12 w-[60%] rounded-lg" />
        <div className="flex justify-end">
          <Skeleton className="h-16 w-[70%] rounded-lg" />
        </div>
      </div>

      {/* Input area skeleton */}
      <div className="border-t p-4">
        <Skeleton className="h-20 w-full rounded-lg" />
      </div>
    </div>
  );
}
