import React, { useState } from "react";

export interface ProgressChunk {
  seq: number;
  text: string;
}

const COLLAPSED_LIMIT = 3;

export interface ProgressChunksProps {
  chunks: ProgressChunk[];
}

/**
 * Renders inline progress chunks emitted before the final tool output.
 * Collapsed by default when there are more than COLLAPSED_LIMIT chunks.
 * Does NOT auto-scroll — user must expand manually.
 */
export function ProgressChunks({ chunks }: ProgressChunksProps) {
  const [expanded, setExpanded] = useState(false);

  if (chunks.length === 0) return null;

  const isCollapsible = chunks.length > COLLAPSED_LIMIT;
  const visible = expanded ? chunks : chunks.slice(0, COLLAPSED_LIMIT);
  const hiddenCount = chunks.length - COLLAPSED_LIMIT;

  return (
    <div className="flex flex-col gap-0.5 mt-1 pl-4 border-l border-border/50">
      {visible.map((chunk) => (
        <div
          key={chunk.seq}
          data-testid="progress-chunk"
          className="font-mono text-xs text-muted-foreground/80 whitespace-pre-wrap break-all"
        >
          {chunk.text}
        </div>
      ))}
      {isCollapsible && !expanded && (
        <button
          type="button"
          className="text-xs text-muted-foreground/60 hover:text-muted-foreground text-left cursor-pointer"
          onClick={() => setExpanded(true)}
        >
          +{hiddenCount} more chunk{hiddenCount !== 1 ? "s" : ""}
        </button>
      )}
    </div>
  );
}
