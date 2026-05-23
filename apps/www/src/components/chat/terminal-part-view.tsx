import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DBTerminalPart } from "@terragon/shared";

type TerminalChunk = DBTerminalPart["chunks"][number];
const COLLAPSED_CHUNK_LIMIT = 160;
const STICKY_SCROLL_THRESHOLD_PX = 24;

const ChunkLine = memo(function ChunkLine({ chunk }: { chunk: TerminalChunk }) {
  return (
    <div
      data-kind={chunk.kind}
      className={cn("whitespace-pre-wrap break-all", {
        "text-error": chunk.kind === "stderr",
        "text-coral": chunk.kind === "interaction",
        "text-on-dark-soft": chunk.kind === "stdout",
      })}
    >
      {chunk.text}
    </div>
  );
});

export interface TerminalPartViewProps {
  part: DBTerminalPart;
}

export const TerminalPartView = memo(function TerminalPartView({
  part,
}: TerminalPartViewProps) {
  const outputRef = useRef<HTMLDivElement>(null);
  const previousChunkCountRef = useRef(0);
  const [expanded, setExpanded] = useState(false);
  const chunkCount = part.chunks.length;
  const isCollapsible = chunkCount > COLLAPSED_CHUNK_LIMIT;
  const visibleChunks = useMemo(
    () =>
      expanded || !isCollapsible
        ? part.chunks
        : part.chunks.slice(-COLLAPSED_CHUNK_LIMIT),
    [expanded, isCollapsible, part.chunks],
  );
  const hiddenChunkCount = chunkCount - visibleChunks.length;

  useEffect(() => {
    const output = outputRef.current;
    if (!output || chunkCount === previousChunkCountRef.current) {
      previousChunkCountRef.current = chunkCount;
      return;
    }

    const previousChunkCount = previousChunkCountRef.current;
    previousChunkCountRef.current = chunkCount;

    const distanceFromBottom =
      output.scrollHeight - output.scrollTop - output.clientHeight;
    const shouldStickToBottom =
      previousChunkCount === 0 ||
      output.scrollHeight <= output.clientHeight ||
      distanceFromBottom <= STICKY_SCROLL_THRESHOLD_PX;

    if (!shouldStickToBottom) return;

    let frameId: number | undefined;
    const scrollToBottom = () => {
      output.scrollTop = output.scrollHeight;
    };
    if (typeof window !== "undefined" && window.requestAnimationFrame) {
      frameId = window.requestAnimationFrame(scrollToBottom);
    } else {
      scrollToBottom();
    }
    return () => {
      if (
        frameId !== undefined &&
        typeof window !== "undefined" &&
        window.cancelAnimationFrame
      ) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [chunkCount]);

  return (
    <div className="rounded-lg overflow-hidden text-xs font-mono">
      {/* Header band: dark elevated. Terminal is anchored brand chrome —
          always navy regardless of theme. */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-dark-elevated">
        <Terminal className="size-3.5 text-on-dark-soft" />
        <span className="text-xs text-on-dark-soft">Terminal</span>
        <span className="ml-auto text-xs text-on-dark-soft font-mono opacity-70">
          {part.sandboxId.slice(0, 8)}
        </span>
      </div>

      {/* Chunk content on the brand-anchored dark surface. */}
      <div
        ref={outputRef}
        data-testid="terminal-output"
        className="bg-surface-dark p-3 max-h-[240px] overflow-y-auto"
      >
        {part.chunks.length === 0 ? (
          <span className="text-muted-foreground/70 italic">No output</span>
        ) : (
          <>
            {isCollapsible && !expanded ? (
              <button
                type="button"
                className="mb-2 text-left text-on-dark-soft/70 hover:text-on-dark-soft"
                onClick={() => setExpanded(true)}
              >
                Show {hiddenChunkCount} earlier line
                {hiddenChunkCount === 1 ? "" : "s"}
              </button>
            ) : null}
            {visibleChunks.map((chunk) => (
              <ChunkLine key={chunk.streamSeq} chunk={chunk} />
            ))}
          </>
        )}
      </div>
    </div>
  );
});
