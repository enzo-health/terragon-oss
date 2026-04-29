import { cn } from "@/lib/utils";
import React from "react";

export type BannerVariant = "default" | "warning" | "error" | "info";

export function BannerBar({
  variant = "default",
  children,
  rightSlot,
  className,
  id,
}: {
  variant?: BannerVariant;
  children: React.ReactNode;
  rightSlot?: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div
      id={id}
      className={cn(
        "sticky top-0 z-50 w-full border-b",
        variant === "default" && "bg-muted text-muted-foreground border-border",
        variant === "warning" && "bg-warning/10 text-warning border-warning/30",
        variant === "error" && "bg-error/10 text-error border-error/30",
        variant === "info" &&
          "bg-sky-50 text-sky-900 border-sky-200 dark:bg-sky-900/20 dark:text-sky-100 dark:border-sky-800",
        className,
      )}
    >
      <div className="flex w-full items-center justify-between gap-3 py-2 px-4 text-sm font-medium">
        <div className="truncate">{children}</div>
        {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}
      </div>
    </div>
  );
}
