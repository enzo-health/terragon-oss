import React from "react";
import { cn } from "@/lib/utils";

export type MetaChipVariant =
  | "neutral"
  | "active"
  | "warning"
  | "success"
  | "danger";

const VARIANT_CLASSES: Record<MetaChipVariant, string> = {
  // Each variant uses the canonical semantic token (--warning, --success,
  // --error) for border + bg-tint + foreground. One token per variant,
  // no inline oklch literals. Dark-mode coverage flows through the
  // semantic tokens themselves.
  neutral: "border-sunken text-mid",
  active: "border-sunken text-mid",
  warning: "border-warning/70 bg-warning/12 text-warning dark:bg-warning/20",
  success: "border-success/60 bg-success/12 text-success dark:bg-success/20",
  danger: "border-error/70 bg-error/12 text-error dark:bg-error/20",
};

export interface MetaChipProps {
  variant?: MetaChipVariant;
  icon?: React.ReactNode;
  children: React.ReactNode;
  title?: string;
  /** Test selector — passed through unchanged. */
  "data-testid"?: string;
  /** State indicator for tests / styling hooks. */
  "data-state"?: string;
  className?: string;
}

/**
 * Shared chip primitive for the chat header meta row.
 * Standardises radius, padding, typography, dark-mode coverage, and tabular
 * numerals. Use a variant rather than custom colors.
 */
export function MetaChip({
  variant = "neutral",
  icon,
  children,
  title,
  className,
  ...rest
}: MetaChipProps) {
  return (
    <div
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors",
        VARIANT_CLASSES[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </div>
  );
}
