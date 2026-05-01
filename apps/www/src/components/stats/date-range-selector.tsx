"use client";

import { Button } from "@/components/ui/button";

const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
] as const;

export function DateRangeSelector({
  numDays,
  onNumDaysChange,
}: {
  numDays: number;
  onNumDaysChange: (numDays: number) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Date range" className="flex gap-2">
      {RANGES.map(({ days, label }) => {
        const isActive = numDays === days;
        return (
          <Button
            key={days}
            role="radio"
            aria-checked={isActive}
            variant={isActive ? "default" : "outline"}
            size="sm"
            className="tabular-nums"
            onClick={() => {
              onNumDaysChange(days);
            }}
          >
            {label}
          </Button>
        );
      })}
    </div>
  );
}
