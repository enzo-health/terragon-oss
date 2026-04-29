import React, { useEffect, useRef } from "react";
import { Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DBTerminalPart } from "@terragon/shared";

type TerminalChunk = DBTerminalPart["chunks"][number];

function ChunkLine({ chunk }: { chunk: TerminalChunk }) {
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
}

export interface TerminalPartViewProps {
  part: DBTerminalPart;
}

export function TerminalPartView({ part }: TerminalPartViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const chunkCount = part.chunks.length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: auto-scroll on append
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
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
      <div className="bg-surface-dark p-3 max-h-[240px] overflow-y-auto">
        {part.chunks.length === 0 ? (
          <span className="text-muted-foreground/70 italic">No output</span>
        ) : (
          part.chunks.map((chunk) => (
            <ChunkLine key={chunk.streamSeq} chunk={chunk} />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
