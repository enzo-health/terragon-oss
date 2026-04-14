import React from "react";
import { Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ThreadMetaSnapshot } from "./use-thread-meta-events";

export interface RateLimitChipProps {
  rateLimits: ThreadMetaSnapshot["rateLimits"];
}

/**
 * Rate-limit chip — shows a warning when any of the rate-limit values
 * suggests the quota is >80% consumed.
 *
 * The exact shape of `rateLimits` is opaque (depends on the Claude API
 * response headers forwarded by the daemon).  We surface a generic
 * warning badge until the field shape is normalised in a follow-up.
 */
export function RateLimitChip({ rateLimits }: RateLimitChipProps) {
  if (!rateLimits) return null;

  // Heuristic: if the record is non-empty we know limits were reported.
  const entries = Object.entries(rateLimits);
  if (entries.length === 0) return null;

  // Detect warning: look for `remaining` / `limit` pair where remaining < 20%
  let isWarning = false;
  const remaining = rateLimits["requests_remaining"] ?? rateLimits["remaining"];
  const limit = rateLimits["requests_limit"] ?? rateLimits["limit"];
  if (typeof remaining === "number" && typeof limit === "number" && limit > 0) {
    isWarning = remaining / limit < 0.2;
  }

  return (
    <div
      data-testid="rate-limit-chip"
      data-state={isWarning ? "warning" : "active"}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        isWarning
          ? "border-amber-400 text-amber-600 bg-amber-500/5"
          : "border-border text-muted-foreground",
      )}
    >
      <Gauge className="size-3" />
      {isWarning ? "Rate limit" : "Limits OK"}
    </div>
  );
}
