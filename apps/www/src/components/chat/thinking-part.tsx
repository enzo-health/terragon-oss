import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ThinkingPartProps {
  thinking: string;
  isLatest?: boolean;
  isAgentWorking?: boolean;
}

export function getThinkingTitle(thinking: string): string {
  // If the thinking part starts with a "header" like **Thinking**, return the header
  // this is the format that codex typically uses for its thinking.
  const match = thinking.match(/^\*\*(.*?)\*\*/);
  if (match) {
    // Return the matched content, even if it's an empty string
    // The nullish coalescing was the original issue - match[1] is never null/undefined here
    return match[1]?.trim() ?? "Thinking";
  }
  return "Thinking";
}

const ThinkingPart = memo(function ThinkingPart({
  thinking,
  isLatest = false,
  isAgentWorking = false,
}: ThinkingPartProps) {
  const [isExpanded, setIsExpanded] = useState(isLatest);
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef<number>(Date.now());

  const isActive = isLatest && isAgentWorking;

  useEffect(() => {
    if (!isActive) return;
    startTimeRef.current = Date.now();
    setElapsed(0);
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isActive]);

  const title = getThinkingTitle(thinking);
  const displayTitle =
    isActive && elapsed > 0 ? `${title} (${elapsed}s)` : title;

  const components = useMemo(
    () => ({
      p({ children }: any) {
        return <p className="mb-2 last:mb-0 break-all">{children}</p>;
      },
      ul({ children }: any) {
        return <ul className="list-disc pl-4 mb-2 break-all">{children}</ul>;
      },
      ol({ children }: any) {
        return <ol className="list-decimal pl-4 mb-2 break-all">{children}</ol>;
      },
      li({ children }: any) {
        return <li className="mb-1 break-all">{children}</li>;
      },
      code({ children }: any) {
        return (
          <code className="bg-background/50 px-1 py-0.5 rounded text-xs font-mono break-all">
            {children}
          </code>
        );
      },
      blockquote({ children }: any) {
        return (
          <blockquote className="border-l-2 border-border pl-3 italic my-2">
            {children}
          </blockquote>
        );
      },
    }),
    [],
  );

  if (!isExpanded) {
    return (
      <button
        onClick={() => setIsExpanded(true)}
        className={cn(
          "flex items-center gap-1 py-1 text-sm text-muted-foreground italic",
          isActive && "animate-pulse",
        )}
      >
        <ChevronRight className="h-4 w-4 shrink-0" />
        <span className="truncate">{displayTitle}</span>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 text-sm italic text-muted-foreground">
      <button
        onClick={() => setIsExpanded(false)}
        className={cn(
          "flex items-center gap-1 py-1 w-fit",
          isActive && "animate-pulse",
        )}
      >
        <ChevronDown className="h-4 w-4 shrink-0" />
        <span className="truncate">
          {isActive ? displayTitle : "Thinking..."}
        </span>
      </button>
      <div className="overflow-hidden break-all">
        <Streamdown components={components}>{thinking}</Streamdown>
      </div>
    </div>
  );
});

export { ThinkingPart };
