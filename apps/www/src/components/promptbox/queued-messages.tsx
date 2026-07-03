"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import { DBUserMessage } from "@terragon/shared";
import { AIAgent } from "@terragon/agent/types";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { ChevronRight, X } from "lucide-react";
import { QueuedUserPart } from "./queued-user-parts";

interface QueuedMessagesProps {
  messages: DBUserMessage[];
  agent: AIAgent;
  onRemove: (idx: number) => void;
  className?: string;
}

export function QueuedMessages({
  messages,
  agent: _agent,
  onRemove,
  className,
}: QueuedMessagesProps) {
  if (messages.length === 0) {
    return null;
  }
  return (
    <div className="bg-background">
      <Collapsible.Root
        defaultOpen
        className={cn(
          "group/queued",
          "border-t border-x rounded-tl-md rounded-tr-md border-border bg-muted/50",
          "pb-2 -mb-2 overflow-hidden",
          "animate-in fade-in slide-in-from-bottom-1 duration-[var(--duration-base)] ease-[var(--ease-emphasis)]",
          className,
        )}
      >
        <div className="p-2 pb-0 space-y-2">
          <Collapsible.Trigger
            className={cn(
              "w-full text-xs text-muted-foreground font-medium flex items-center",
              "cursor-pointer rounded-sm outline-none hover:text-foreground",
              "focus-visible:ring-2 focus-visible:ring-coral/50",
              "transition-colors duration-[var(--duration-quick)] ease-[var(--ease-standard)]",
            )}
          >
            <ChevronRight className="size-4 transition-transform duration-[var(--duration-quick)] ease-[var(--ease-standard)] group-data-open/queued:rotate-90" />
            <span className="px-1 font-mono">Queued ({messages.length})</span>
          </Collapsible.Trigger>
          <Collapsible.Panel
            className={cn(
              "overflow-hidden h-(--collapsible-panel-height)",
              "transition-[height] duration-[var(--duration-quick)] ease-[var(--ease-standard)]",
              "data-starting-style:h-0 data-ending-style:h-0",
            )}
          >
            <div className="max-h-[20vh] overflow-y-auto space-y-2 pb-2">
              {messages.map((message, index) => {
                return (
                  <div key={index} className="flex relative items-start gap-1">
                    <div className="ml-0 pr-10 flex flex-col gap-1 text-[length:var(--text-fluid-base)] leading-relaxed">
                      {message.parts.map((part, partIndex) => (
                        <QueuedUserPart key={partIndex} part={part} />
                      ))}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove queued message"
                      className="size-6 hover:bg-transparent cursor-pointer shrink-0 py-5 -ml-8 z-10 opacity-75 hover:opacity-100"
                      onClick={() => onRemove?.(index)}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </Collapsible.Panel>
        </div>
      </Collapsible.Root>
    </div>
  );
}
