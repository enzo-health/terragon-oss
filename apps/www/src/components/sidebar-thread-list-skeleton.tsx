const THREAD_LIST_SKELETON_ROWS = [0, 1, 2, 3, 4];

export function SidebarThreadListLoading() {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <div className="size-3 flex-shrink-0 rounded bg-muted/60 motion-safe:animate-pulse" />
        <div className="h-2.5 w-20 rounded bg-muted motion-safe:animate-pulse" />
        <div className="ml-auto size-2.5 rounded bg-muted/60 motion-safe:animate-pulse" />
      </div>
      <div className="flex flex-col gap-0.5 px-1 pb-1">
        {THREAD_LIST_SKELETON_ROWS.map((row) => (
          <div key={row} className="flex items-center gap-2 px-2 py-1.5 pr-8">
            <div className="size-3.5 flex-shrink-0 rounded-full bg-muted/60 motion-safe:animate-pulse" />
            <div className="h-3 w-3/4 rounded bg-muted/60 motion-safe:animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}
