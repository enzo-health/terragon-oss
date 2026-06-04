// Single source of the sidebar thread-list loading skeleton. Shared by the
// dynamic-import fallback, the Suspense boundary, and SidebarThreadList's own
// isLoading branch so the list loads with one vocabulary, not three.
export function SidebarThreadListLoading() {
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="h-3 w-20 rounded bg-muted animate-pulse" />
      <div className="h-8 rounded-md bg-muted/70 animate-pulse" />
      <div className="h-8 rounded-md bg-muted/50 animate-pulse" />
      <div className="h-8 rounded-md bg-muted/40 animate-pulse" />
    </div>
  );
}
