import { cn } from "@/lib/utils";

// Canonical status pill: bg-{semantic}/10 text-{semantic}, rounded-full.
// Connected reads as success; not-connected falls back to a quiet mid-text
// label without a chip fill (the absence of state is itself the signal).
export function ConnectionStatusPill({ connected }: { connected: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full font-mono text-xs px-2.5 py-0.5",
        connected ? "bg-success/10 text-success" : "text-mid",
      )}
    >
      {connected ? "Connected" : "Not Connected"}
    </span>
  );
}
