// Single source of the sidebar thread-list loading skeleton. Shared by the
// dynamic-import fallback, the Suspense boundary, and SidebarThreadList's own
// isLoading branch so the list loads with one vocabulary, not three.
export function SidebarThreadListLoading() {
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="h-3 w-20 rounded bg-muted animate-pulse" />
      <div className="flex items-start gap-2 px-1 py-1">
        <div className="size-3.5 rounded-full bg-muted/60 animate-pulse flex-shrink-0" />
        <div className="flex flex-col gap-1 flex-1">
          <div className="h-3 w-3/4 rounded bg-muted/60 animate-pulse" />
          <div className="h-2 w-1/2 rounded bg-muted/60 animate-pulse" />
        </div>
      </div>
      <div className="flex items-start gap-2 px-1 py-1">
        <div className="size-3.5 rounded-full bg-muted/60 animate-pulse flex-shrink-0" />
        <div className="flex flex-col gap-1 flex-1">
          <div className="h-3 w-3/4 rounded bg-muted/60 animate-pulse" />
          <div className="h-2 w-1/2 rounded bg-muted/60 animate-pulse" />
        </div>
      </div>
      <div className="flex items-start gap-2 px-1 py-1">
        <div className="size-3.5 rounded-full bg-muted/60 animate-pulse flex-shrink-0" />
        <div className="flex flex-col gap-1 flex-1">
          <div className="h-3 w-3/4 rounded bg-muted/60 animate-pulse" />
          <div className="h-2 w-1/2 rounded bg-muted/60 animate-pulse" />
        </div>
      </div>
    </div>
  );
}
