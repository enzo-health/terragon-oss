"use client";

export function CreatingIndicator() {
  return (
    <span className="inline-flex items-center gap-1.5 text-primary">
      <span className="inline-flex rounded-full size-2 bg-primary/60" />
      <span className="text-micro font-medium tracking-wide uppercase">
        Creating
      </span>
    </span>
  );
}
