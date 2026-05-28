import { Skeleton } from "@/components/ui/skeleton";
import { headerClassName, headerSurfaceClassName } from "../shared/header";
import { cn } from "@/lib/utils";

export function ChatUISkeleton() {
  return (
    <div
      className="flex h-full flex-col animate-in fade-in duration-[var(--duration-quick)] ease-[var(--ease-emphasis)]"
      aria-hidden
    >
      <div
        className={cn(
          headerClassName,
          headerSurfaceClassName,
          "flex items-center justify-between px-3",
        )}
      >
        <div className="flex items-center gap-2">
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="size-5 rounded-full" />
          <Skeleton className="h-4 w-40 rounded-sm" />
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
        <div className="flex items-center gap-1.5">
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="size-8 rounded-md" />
        </div>
      </div>

      <div className="flex-1" />

      <div className="max-w-chat w-full mx-auto px-4 pb-3 pt-2">
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    </div>
  );
}
