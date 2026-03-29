"use client";

import {
  default as React,
  memo,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "./markdown-renderer";

type ReasoningBlockProps = {
  thinking: string;
  isLatest?: boolean;
  isAgentWorking?: boolean;
};

export function getReasoningTitle(thinking: string): string {
  const match = thinking.match(/^\*\*(.*?)\*\*/);
  if (match) {
    return match[1]?.trim() ?? "Thinking";
  }
  return "Thinking";
}

function stripLeadingReasoningTitle(thinking: string): string {
  return thinking.replace(/^\*\*.*?\*\*\s*/s, "");
}

export const ReasoningBlock = memo(function ReasoningBlock({
  thinking,
  isLatest = false,
  isAgentWorking = false,
}: ReasoningBlockProps) {
  const [isExpanded, setIsExpanded] = useState(isLatest);
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef<number>(Date.now());
  const contentId = useId();
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

  const title = getReasoningTitle(thinking);
  const content = stripLeadingReasoningTitle(thinking);
  const displayTitle =
    isActive && elapsed > 0 ? `${title} (${elapsed}s)` : title;

  useEffect(() => {
    if (isLatest) {
      setIsExpanded(true);
    }
  }, [isLatest]);

  if (!isExpanded) {
    return (
      <button
        type="button"
        onClick={() => setIsExpanded(true)}
        className={cn(
          "flex items-center gap-1 py-1 text-sm text-muted-foreground italic",
          isActive && "animate-pulse",
        )}
        aria-expanded={false}
        aria-controls={contentId}
      >
        <ChevronRight className="h-4 w-4 shrink-0" />
        <span className="truncate">{displayTitle}</span>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 text-sm italic text-muted-foreground">
      <button
        type="button"
        onClick={() => setIsExpanded(false)}
        className={cn(
          "flex items-center gap-1 py-1 w-fit",
          isActive && "animate-pulse",
        )}
        aria-expanded
        aria-controls={contentId}
      >
        <ChevronDown className="h-4 w-4 shrink-0" />
        <span className="truncate">{displayTitle}</span>
      </button>
      <div id={contentId} className="overflow-hidden break-words">
        <MarkdownRenderer
          content={content}
          streaming={isActive}
          variant="reasoning"
        />
      </div>
    </div>
  );
});
