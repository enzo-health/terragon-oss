"use client";

import React from "react";
import { useState } from "react";
import { UIPart } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { AIAgent } from "@terragon/agent/types";
import { ChevronRight } from "lucide-react";
import { MessagePart } from "./message-part";
import { MessagePartRenderProps, PartGroup } from "./chat-message.types";
import { cn } from "@/lib/utils";

function CollapsibleAgentActivityGroupLabel() {
  // A `CollapsibleAgentActivityGroup` is, by construction, never the latest
  // group in its message: `groupParts` renders the message's last part
  // (and anything at or after the last text part) as its own
  // non-collapsible group. So any collapsed block represents historical
  // activity that has been superseded by visible content beneath it.
  // Labeling it "Working..." based on a message/thread-level active flag
  // was misleading — the thread footer already communicates that state.
  return <span className="truncate">Finished working</span>;
}

export function CollapsibleAgentActivityGroup({
  group,
  agent,
  isLatestMessage = false,
  isAgentWorking = false,
  messagePartProps,
  artifactDescriptors,
  onOpenArtifact,
  planOccurrences,
}: {
  group: PartGroup;
  agent: AIAgent | null;
  isLatestMessage: boolean;
  isAgentWorking: boolean;
  messagePartProps: MessagePartRenderProps;
  artifactDescriptors: ArtifactDescriptor[];
  onOpenArtifact: (artifactId: string) => void;
  planOccurrences: Map<UIPart, number>;
}) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const numParts = group.parts.length;
  return (
    <div className="flex flex-col gap-0.5 group/item">
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="flex items-center gap-1.5 py-1 text-xs font-medium text-muted-foreground/70 hover:text-muted-foreground transition-colors"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform duration-200 ease-[var(--ease-standard)]",
            !isCollapsed && "rotate-90",
          )}
        />
        <CollapsibleAgentActivityGroupLabel />
      </button>
      {!isCollapsed && (
        <div className="flex flex-col gap-2 p-4 max-h-[50dvh] overflow-y-auto border border-border/40 rounded-lg bg-muted/15 animate-in fade-in slide-in-from-top-1 duration-200">
          {group.parts.map((part, partIndex) => {
            return (
              <MessagePart
                key={partIndex}
                part={part}
                isLatest={isLatestMessage && partIndex === numParts - 1}
                isAgentWorking={isAgentWorking}
                {...messagePartProps}
                artifactDescriptors={artifactDescriptors}
                onOpenArtifact={onOpenArtifact}
                planOccurrenceIndex={planOccurrences.get(part)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
