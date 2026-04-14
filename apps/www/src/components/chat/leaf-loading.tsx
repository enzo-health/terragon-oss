import { memo } from "react";

const LeafLoading = memo(function LeafLoading({
  message = "Loading",
}: {
  message?: string | React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 px-2 text-muted-foreground text-sm">
      <div className="typing-dots flex items-center gap-[3px]" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <span className="flex items-center gap-1">{message}</span>
    </div>
  );
});

export { LeafLoading };
