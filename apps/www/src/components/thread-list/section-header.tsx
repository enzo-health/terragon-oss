"use client";

import { ChevronRight } from "lucide-react";
import type { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

type ThreadListSectionHeaderProps = {
  title: string;
  numThreads: number;
  isCollapsed: boolean;
  onToggle: () => void;
  className?: string;
};

export function ThreadListSectionHeader({
  title,
  numThreads,
  isCollapsed,
  onToggle,
  className,
}: ThreadListSectionHeaderProps) {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggle();
    }
  };
  return (
    <button
      type="button"
      className={cn(
        "group w-full py-1.5 md:py-1 text-micro uppercase tracking-[0.06em] font-semibold text-muted-foreground flex items-center gap-1.5 min-w-0 cursor-pointer select-none hover:text-foreground transition-colors sticky top-0 z-10 bg-sidebar pl-2 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:rounded-sm focus-visible:outline-none",
        "animate-in fade-in slide-in-from-left-2 duration-300",
        className,
      )}
      onClick={onToggle}
      onKeyDown={handleKeyDown}
      title={title}
    >
      <ChevronRight
        className={cn(
          "size-3 flex-shrink-0 text-muted-foreground transition-transform duration-200 ease-[var(--ease-standard)]",
          !isCollapsed && "rotate-90",
        )}
      />
      <span className="truncate normal-case tracking-normal">{title}</span>
      <span className="text-muted-foreground/70 font-sans text-[10px] font-medium tabular-nums flex-shrink-0">
        {numThreads}
      </span>
    </button>
  );
}
