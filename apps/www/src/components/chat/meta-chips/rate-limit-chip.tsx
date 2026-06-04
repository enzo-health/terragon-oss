import React from "react";
import { Gauge } from "lucide-react";
import { MetaChip } from "./meta-chip";
import type { ThreadMetaSnapshot } from "./use-thread-meta-events";

export interface RateLimitChipProps {
  rateLimits: ThreadMetaSnapshot["rateLimits"];
}

/**
 * Rate-limit chip — shows a warning when any of the rate-limit values
 * suggests the quota is >80% consumed.
 */
export function RateLimitChip({ rateLimits }: RateLimitChipProps) {
  if (!rateLimits) return null;
  const entries = Object.entries(rateLimits);
  if (entries.length === 0) return null;

  let isWarning = false;
  const remaining = rateLimits["requests_remaining"] ?? rateLimits["remaining"];
  const limit = rateLimits["requests_limit"] ?? rateLimits["limit"];
  if (typeof remaining === "number" && typeof limit === "number" && limit > 0) {
    isWarning = remaining / limit < 0.2;
  }

  return (
    <MetaChip
      data-testid="rate-limit-chip"
      data-state={isWarning ? "warning" : "active"}
      variant={isWarning ? "warning" : "active"}
      icon={<Gauge className="size-3" />}
    >
      {isWarning ? "Rate limit" : "Limits"}
    </MetaChip>
  );
}
