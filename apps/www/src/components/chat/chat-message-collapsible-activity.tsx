"use client";

import React, { memo, useMemo } from "react";
import { useState } from "react";
import { UIPart } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import type { ArtifactDescriptorLookup } from "./secondary-panel-helpers";
import { AIAgent } from "@terragon/agent/types";
import { ChevronRight } from "lucide-react";
import { MessagePart } from "./message-part";
import { MessagePartRenderProps, PartGroup } from "./chat-message.types";
import { summarizeActivityGroup } from "./tools/activity-summary";
import { cn } from "@/lib/utils";

function CollapsibleAgentActivityGroupLabel({ group }: { group: PartGroup }) {
  // A `CollapsibleAgentActivityGroup` is, by construction, never the latest
  // group in its message: `groupParts` renders the message's last part
  // (and anything at or after the last text part) as its own
  // non-collapsible group. So any collapsed block represents historical
  // activity that has been superseded by visible content beneath it.
  //
  // The label is a Codex-style activity summary of the collapsed tool calls
  // ("Explored 4 files, 1 search, ran 1 command"). Reasoning-only groups (no
  // countable tool activity) fall back to the generic "Finished working".
  const summary = useMemo(
    () => summarizeActivityGroup(group.parts),
    [group.parts],
  );
  return <span className="truncate">{summary ?? "Finished working"}</span>;
}

type CollapsibleAgentActivityGroupProps = {
  group: PartGroup;
  agent: AIAgent | null;
  isLatestMessage: boolean;
  isAgentWorking: boolean;
  messagePartProps: MessagePartRenderProps;
  artifactDescriptors: ArtifactDescriptor[];
  artifactDescriptorLookup?: ArtifactDescriptorLookup;
  onOpenArtifact: (artifactId: string) => void;
  planOccurrences: Map<UIPart, number>;
};

export const CollapsibleAgentActivityGroup = memo(
  function CollapsibleAgentActivityGroup({
    group,
    agent,
    isLatestMessage = false,
    isAgentWorking = false,
    messagePartProps,
    artifactDescriptors,
    artifactDescriptorLookup,
    onOpenArtifact,
    planOccurrences,
  }: CollapsibleAgentActivityGroupProps) {
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
          <CollapsibleAgentActivityGroupLabel group={group} />
        </button>
        {/* Color-block surface (no border) — one elevation step above the
            canvas via surface-soft. The previous 15% muted bg + half-opacity
            border read as a faded box rather than an intentional surface. */}
        {!isCollapsed && (
          <div className="flex flex-col gap-2 p-4 max-h-[50dvh] overflow-y-auto rounded-lg bg-surface-soft animate-in fade-in slide-in-from-top-1 duration-200">
            {group.parts.map((part, partIndex) => {
              return (
                <MessagePart
                  key={partIndex}
                  part={part}
                  isLatest={isLatestMessage && partIndex === numParts - 1}
                  isAgentWorking={isAgentWorking}
                  {...messagePartProps}
                  artifactDescriptors={artifactDescriptors}
                  artifactDescriptorLookup={artifactDescriptorLookup}
                  onOpenArtifact={onOpenArtifact}
                  planOccurrenceIndex={planOccurrences.get(part)}
                />
              );
            })}
          </div>
        )}
      </div>
    );
  },
  areCollapsibleAgentActivityGroupPropsEqual,
);

function areCollapsibleAgentActivityGroupPropsEqual(
  prev: CollapsibleAgentActivityGroupProps,
  next: CollapsibleAgentActivityGroupProps,
): boolean {
  if (prev.group.type !== next.group.type) return false;
  if (prev.group.parts.length !== next.group.parts.length) return false;
  for (let i = 0; i < prev.group.parts.length; i++) {
    if (prev.group.parts[i] !== next.group.parts[i]) return false;
  }
  return (
    prev.agent === next.agent &&
    prev.isLatestMessage === next.isLatestMessage &&
    prev.isAgentWorking === next.isAgentWorking &&
    prev.messagePartProps === next.messagePartProps &&
    prev.artifactDescriptors === next.artifactDescriptors &&
    prev.artifactDescriptorLookup === next.artifactDescriptorLookup &&
    prev.onOpenArtifact === next.onOpenArtifact &&
    prev.planOccurrences === next.planOccurrences
  );
}
