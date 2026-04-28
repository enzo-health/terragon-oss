import React from "react";
import { cn } from "@/lib/utils";

export type MetaChipVariant =
  | "neutral"
  | "active"
  | "warning"
  | "success"
  | "danger";

const VARIANT_CLASSES: Record<MetaChipVariant, string> = {
  // Resting state — sits on hairline, no semantic charge
  neutral: "border-hairline text-muted-foreground",
  // Carrying current data, but nothing to flag
  active: "border-hairline text-muted-foreground",
  // Needs attention — uses the brand's accent-amber, which harmonizes with
  // the cream canvas (a saturated yellow-orange would clash). Visual weight
  // matches semantic weight via 12% surface tint + ink-dark text.
  warning:
    "border-[color:var(--accent-amber)]/70 bg-[color:var(--accent-amber)]/12 text-[color:oklch(0.42_0.10_65)] dark:bg-[color:var(--accent-amber)]/15 dark:text-[color:var(--accent-amber)]",
  // Healthy / ready — uses the brand's accent-teal so it doesn't drift toward
  // the SaaS-default emerald.
  success:
    "border-[color:var(--accent-teal)]/60 bg-[color:var(--accent-teal)]/12 text-[color:oklch(0.42_0.07_175)] dark:bg-[color:var(--accent-teal)]/15 dark:text-[color:var(--accent-teal)]",
  // Failure — coral-red borrowed from the brand's destructive token so
  // failures speak in the brand's voice rather than a generic Tailwind red.
  danger:
    "border-destructive/70 bg-destructive/12 text-destructive dark:bg-destructive/20 dark:text-[color:oklch(0.78_0.15_27)]",
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
