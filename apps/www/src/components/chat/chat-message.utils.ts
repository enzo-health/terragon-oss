import { AllToolParts, UIMessage, UIPart } from "@terragon/shared";
import { extractProposedPlanText } from "@terragon/shared/db/artifact-descriptors";
import { PartGroup, UIUserOrAgentPart } from "./chat-message.types";

export function toolPartContainsName(
  part: AllToolParts,
  toolName: string,
): boolean {
  if (part.name === toolName) {
    return true;
  }
  if (part.name !== "Task") {
    return false;
  }
  return part.parts.some(
    (childPart) =>
      childPart.type === "tool" && toolPartContainsName(childPart, toolName),
  );
}

export function messageContainsToolName(
  message: UIMessage,
  toolName: string,
): boolean {
  if (message.role !== "agent") {
    return false;
  }
  return message.parts.some(
    (part) => part.type === "tool" && toolPartContainsName(part, toolName),
  );
}

// Never collapse these tool names
export const nonCollapsibleToolNames = new Set<string>([
  "SuggestFollowupTask",
  "mcp__terry__SuggestFollowupTask",
  "ExitPlanMode",
  "PermissionRequest",
]);

export function getPartGroupType({
  part,
  partIdx,
  numParts,
  lastTextPartIdx,
}: {
  part: UIUserOrAgentPart;
  partIdx: number;
  numParts: number;
  lastTextPartIdx: number;
}): PartGroup["type"] {
  const isLastPart = partIdx === numParts - 1;
  if (isLastPart) {
    return part.type;
  }
  const isLastTextPartOrAfter =
    lastTextPartIdx !== -1 && lastTextPartIdx <= partIdx;
  if (isLastTextPartOrAfter) {
    return part.type;
  }
  switch (part.type) {
    case "tool": {
      if (nonCollapsibleToolNames.has(part.name)) {
        return part.type;
      }
      return "collapsible-agent-activity";
    }
    case "text":
    case "thinking": {
      return "collapsible-agent-activity";
    }
    default: {
      return part.type;
    }
  }
}

// Group image parts together and identify collapsible tool sequences
export function groupParts({
  parts,
  isLatestMessage,
  isAgentWorking,
}: {
  parts: UIUserOrAgentPart[];
  isLatestMessage: boolean;
  isAgentWorking: boolean;
}): PartGroup[] {
  const groups: PartGroup[] = [];
  let currentGroup: PartGroup | null = null;

  // Find the index of the last text part in the message
  let lastTextPartIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]?.type === "text") {
      lastTextPartIdx = i;
      break;
    }
  }

  const numParts = parts.length;
  for (let i = 0; i < numParts; i++) {
    const part = parts[i];
    if (!part) {
      continue;
    }
    const partGroupType = getPartGroupType({
      part,
      partIdx: i,
      numParts,
      lastTextPartIdx,
    });
    if (currentGroup === null) {
      currentGroup = { type: partGroupType, parts: [part] };
      continue;
    }
    if (partGroupType === currentGroup.type) {
      currentGroup.parts.push(part);
      continue;
    }
    if (partGroupType !== currentGroup.type) {
      groups.push(currentGroup);
      currentGroup = { type: partGroupType, parts: [part] };
      continue;
    }
  }
  // Handle the last group
  if (currentGroup) {
    groups.push(currentGroup);
  }
  return groups;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0
    ? `${minutes}m ${remainingSeconds}s`
    : `${minutes}m`;
}

/**
 * Builds a map of part object -> plan occurrence index for parts that contain
 * identical `<proposed_plan>` text. Keyed by reference so that group-level
 * lookups work regardless of which subset of parts is being iterated.
 */
export function buildPlanOccurrenceMap(parts: UIPart[]): Map<UIPart, number> {
  const counts = new Map<string, number>();
  const result = new Map<UIPart, number>();
  for (const part of parts) {
    if (part.type !== "text") continue;
    const planText = extractProposedPlanText(part.text);
    if (!planText) continue;
    const count = counts.get(planText) ?? 0;
    result.set(part, count);
    counts.set(planText, count + 1);
  }
  return result;
}
