"use client";

import React, { useMemo, useState } from "react";
import { DBUserMessage } from "@leo/shared";
import { AIAgent } from "@leo/agent/types";
import { cn } from "@/lib/utils";
import { ChatMessage } from "../chat/chat-message";
import { toUIMessages } from "../chat/toUIMessages";
import { Button } from "../ui/button";
import { ChevronRight, X } from "lucide-react";

interface QueuedMessagesProps {
  messages: DBUserMessage[];
  agent: AIAgent;
  onRemove: (idx: number) => void;
  className?: string;
}

export function QueuedMessages({
  messages,
  agent,
  onRemove,
  className,
}: QueuedMessagesProps) {
  const uiMessages = useMemo(() => {
    // We don't want to merge queued messages the same way we do
    // regular messages so that the user can delete them individually.
    return messages.map(
      (message) => toUIMessages({ agent, dbMessages: [message] })[0]!,
    );
  }, [messages, agent]);
  const [collapsed, setCollapsed] = useState(false);
  if (messages.length === 0) {
    return null;
  }
  return (
    <div className="bg-background">
      <div
        className={cn(
          "border-t border-x rounded-tl-md rounded-tr-md border-border bg-muted/50",
          "pb-2 -mb-2 overflow-hidden",
          className,
        )}
      >
        <div
          className={cn("p-2 pb-0 space-y-2", {
            "pb-2": collapsed,
          })}
        >
          <div
            className="w-full text-xs text-muted-foreground font-medium flex items-center"
            onClick={() => setCollapsed(!collapsed)}
          >
            <ChevronRight
              className={cn("size-4 transition-transform", {
                "rotate-90": !collapsed,
              })}
            />
            <span className="px-1 font-mono">Queued ({messages.length})</span>
          </div>
          {!collapsed && (
            <div className="max-h-[20vh] overflow-y-auto space-y-2 pb-2">
              {uiMessages.map((message, index) => {
                return (
                  <div key={index} className="flex relative items-start gap-1">
                    <ChatMessage message={message} className="ml-0 pr-10" />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 hover:bg-transparent cursor-pointer shrink-0 py-5 -ml-8 z-10 opacity-75 hover:opacity-100"
                      onClick={() => onRemove?.(index)}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
