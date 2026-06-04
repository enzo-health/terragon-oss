// Single source of the sidebar thread-list loading skeleton. Shared by the
// dynamic-import fallback, the Suspense boundary, and SidebarThreadList's own
// isLoading branch so the list loads with one vocabulary, not three.
export function SidebarThreadListLoading() {
  return (
    <div className="flex flex-col gap-0.5 px-1 pb-1">
      <div className="mb-0.5 h-3 w-20 rounded bg-muted animate-pulse" />
      <div className="flex items-center gap-2 px-2 py-1.5">
        <div className="size-3.5 rounded-full bg-muted/60 animate-pulse flex-shrink-0" />
        <div className="h-3 w-3/4 rounded bg-muted/60 animate-pulse" />
      </div>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <div className="size-3.5 rounded-full bg-muted/60 animate-pulse flex-shrink-0" />
        <div className="h-3 w-3/4 rounded bg-muted/60 animate-pulse" />
      </div>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <div className="size-3.5 rounded-full bg-muted/60 animate-pulse flex-shrink-0" />
        <div className="h-3 w-3/4 rounded bg-muted/60 animate-pulse" />
      </div>
    </div>
  );
}
