import React, { useState } from "react";

export interface ProgressChunk {
  seq: number;
  text: string;
}

const COLLAPSED_LIMIT = 3;

export interface ProgressChunksProps {
  chunks: ProgressChunk[];
  hiddenCount?: number;
}

/**
 * Renders inline progress chunks emitted before the final tool output.
 * Collapsed by default when there are more than COLLAPSED_LIMIT chunks.
 * Does NOT auto-scroll — user must expand manually.
 */
export function ProgressChunks({
  chunks,
  hiddenCount = 0,
}: ProgressChunksProps) {
  const [expanded, setExpanded] = useState(false);

  if (chunks.length === 0) return null;

  const isCollapsible = chunks.length > COLLAPSED_LIMIT;
  const visible = expanded ? chunks : chunks.slice(-COLLAPSED_LIMIT);
  const localHiddenCount = isCollapsible ? chunks.length - COLLAPSED_LIMIT : 0;

  return (
    <div className="flex flex-col gap-0.5 mt-1 pl-4 border-l border-border/50">
      {hiddenCount > 0 && (
        <div className="text-xs text-muted-foreground/50">
          {hiddenCount} older update{hiddenCount === 1 ? "" : "s"} omitted
        </div>
      )}
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
          Show {localHiddenCount} earlier retained update
          {localHiddenCount !== 1 ? "s" : ""}
        </button>
      )}
    </div>
  );
}
