import React from "react";
import { AlertTriangle } from "lucide-react";
import {
  MAX_CONTEXT_TOKENS,
  CONTEXT_WARNING_PERCENTAGE,
} from "@terragon/shared";

interface ContextWarningProps {
  contextLength: number | null;
  maxContextTokens?: number;
}

export function ContextWarning({
  contextLength,
  maxContextTokens = MAX_CONTEXT_TOKENS,
}: ContextWarningProps) {
  if (contextLength == null) return null;

  const contextRemainingPercentage = Math.max(
    0,
    Math.round(((maxContextTokens - contextLength) / maxContextTokens) * 100),
  );

  if (contextRemainingPercentage > CONTEXT_WARNING_PERCENTAGE) return null;

  return (
    <div className="absolute -top-9 right-6">
      <div className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full border border-border/50 flex items-center gap-1.5">
        <AlertTriangle className="size-3" />
        <span>{contextRemainingPercentage}% context until auto-compact</span>
      </div>
    </div>
  );
}
