"use client";

export function CreatingIndicator() {
  return (
    <span className="inline-flex items-center gap-1.5 text-primary">
      <span className="relative flex size-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/40 opacity-75" />
        <span className="relative inline-flex rounded-full size-2 bg-primary/60" />
      </span>
      <span className="text-micro font-medium tracking-wide uppercase">
        Creating
      </span>
    </span>
  );
}
