import React from "react";
import { Coins } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ThreadMetaSnapshot } from "./use-thread-meta-events";

export interface UsageChipProps {
  tokenUsage: ThreadMetaSnapshot["tokenUsage"];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Chip states: idle (no data), active (showing counts), warning (>80k output). */
export function UsageChip({ tokenUsage }: UsageChipProps) {
  if (!tokenUsage) return null;

  const total = tokenUsage.inputTokens + tokenUsage.outputTokens;
  const isWarning = tokenUsage.outputTokens > 80_000;

  return (
    <div
      data-testid="usage-chip"
      data-state={isWarning ? "warning" : "active"}
      title={`Input: ${tokenUsage.inputTokens}, Cached: ${tokenUsage.cachedInputTokens}, Output: ${tokenUsage.outputTokens}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        isWarning
          ? "border-amber-400 text-amber-600 bg-amber-500/5"
          : "border-border text-muted-foreground",
      )}
    >
      <Coins className="size-3" />
      {formatTokens(total)}
    </div>
  );
}
