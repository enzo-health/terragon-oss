import React from "react";
import { Coins } from "lucide-react";
import { MetaChip } from "./meta-chip";
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
    <MetaChip
      data-testid="usage-chip"
      data-state={isWarning ? "warning" : "active"}
      variant={isWarning ? "warning" : "active"}
      title={`Input: ${tokenUsage.inputTokens.toLocaleString()}, Cached: ${tokenUsage.cachedInputTokens.toLocaleString()}, Output: ${tokenUsage.outputTokens.toLocaleString()}`}
      icon={<Coins className="size-3" />}
    >
      {formatTokens(total)}
    </MetaChip>
  );
}
