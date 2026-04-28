import { cn } from "@/lib/utils";

export function ConnectionStatusPill({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-2 border border-border rounded-full px-2 py-1">
      <span className="text-xs font-mono">
        {connected ? "Connected" : "Not Connected"}
      </span>
      <div className="size-2 relative flex items-center justify-center">
        <div
          className={cn(
            "size-1 rounded-full",
            connected ? "bg-success" : "bg-destructive",
          )}
        />
        <div
          className={cn(
            "absolute inset-0 rounded-full size-2",
            connected ? "bg-success/20" : "bg-destructive/20",
          )}
        />
      </div>
    </div>
  );
}
