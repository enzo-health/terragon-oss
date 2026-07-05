import type { ReactNode } from "react";

function LeafLoading({
  message = "Loading",
}: {
  message?: string | ReactNode;
}) {
  return (
    <output
      aria-live="polite"
      className="flex items-center gap-2.5 px-2 text-muted-foreground text-sm"
    >
      <span className="typing-dots flex items-center gap-[3px]" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <span className="flex items-center gap-1">{message}</span>
    </output>
  );
}

export { LeafLoading };
