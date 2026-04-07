"use client";

import { useState } from "react";
import { UIPart } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { AIAgent } from "@terragon/agent/types";
import { ChevronDown, ChevronRight } from "lucide-react";
import { MessagePart } from "./message-part";
import { MessagePartRenderProps, PartGroup } from "./chat-message.types";

function CollapsibleAgentActivityGroupLabel({
  isLatestMessage,
  isAgentWorking,
}: {
  isLatestMessage: boolean;
  isAgentWorking: boolean;
}) {
  if (isLatestMessage && isAgentWorking) {
    return <span className="truncate animate-shine">Working...</span>;
  }
  return <span className="truncate">Finished working</span>;
}

export function CollapsibleAgentActivityGroup({
  group,
  agent,
  useAiElementsLayout = false,
  isLatestMessage = false,
  isAgentWorking = false,
  messagePartProps,
  artifactDescriptors,
  onOpenArtifact,
  planOccurrences,
}: {
  group: PartGroup;
  agent: AIAgent | null;
  useAiElementsLayout?: boolean;
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
        className="flex items-center gap-1 py-1 text-sm text-muted-foreground opacity-75 group-hover/item:opacity-100 transition-opacity"
      >
        <CollapsibleAgentActivityGroupLabel
          isLatestMessage={isLatestMessage}
          isAgentWorking={isAgentWorking}
        />
        {isCollapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0 opacity-75 group-hover/item:opacity-100 transition-opacity sm:opacity-0" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 opacity-75 group-hover/item:opacity-100 transition-opacity" />
        )}
      </button>
      {!isCollapsed && (
        <div className="flex flex-col gap-2 p-4 max-h-[50dvh] overflow-y-auto border border-border/40 rounded-xl bg-white shadow-inset-edge">
          {group.parts.map((part, partIndex) => {
            return (
              <MessagePart
                key={partIndex}
                part={part}
                isLatest={isLatestMessage && partIndex === numParts - 1}
                isAgentWorking={isAgentWorking}
                useAiElementsLayout={useAiElementsLayout}
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
