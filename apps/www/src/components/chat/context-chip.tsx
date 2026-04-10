import React from "react";
import { MAX_CONTEXT_TOKENS } from "@leo/shared";
import { AlertTriangle } from "lucide-react";

interface ContextChipProps {
  contextLength: number | null;
  maxContextTokens?: number;
  showAlways?: boolean;
}

// Neutral context usage chip: shows % used, no warning icon/text.
export function ContextChip({
  contextLength,
  maxContextTokens = MAX_CONTEXT_TOKENS,
  showAlways = false,
}: ContextChipProps) {
  if (contextLength == null) return null;

  const usedPct = Math.min(
    100,
    Math.max(0, Math.round((contextLength / maxContextTokens) * 100)),
  );

  if (!showAlways && usedPct === 0) return null;

  const showWarning = usedPct >= 70;

  return (
    <div className="absolute -top-9 right-6">
      <div className="text-xs text-muted-foreground bg-muted/50 backdrop-blur-sm px-3 py-1 rounded-full border border-border/50 flex items-center gap-1.5">
        {showWarning && (
          <div title="Task will auto compact at 100% context">
            <AlertTriangle className="size-3" />
          </div>
        )}
        <span>{usedPct}% of context used</span>
      </div>
    </div>
  );
}
