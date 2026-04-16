import { AllToolParts, UIMessage, UIPart } from "@terragon/shared";
import { extractProposedPlanText } from "@terragon/shared/db/artifact-descriptors";
import { PartGroup, UIUserOrAgentPart } from "./chat-message.types";

function toolPartContainsName(part: AllToolParts, toolName: string): boolean {
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
const nonCollapsibleToolNames = new Set<string>([
  "SuggestFollowupTask",
  "mcp__terry__SuggestFollowupTask",
  "ExitPlanMode",
  "PermissionRequest",
]);

function getPartGroupType({
  part,
  partIdx,
  numParts,
  lastTextPartIdx,
  isActiveTurn,
}: {
  part: UIUserOrAgentPart;
  partIdx: number;
  numParts: number;
  lastTextPartIdx: number;
  isActiveTurn: boolean;
}): PartGroup["type"] {
  // For the currently executing agent message (the one the user is actively
  // waiting on), never collapse intermediate tool/text/thinking parts. The
  // user needs live visibility into what the agent is doing right now;
  // activity only becomes "finished" once this message is superseded by a
  // newer agent message or a newer user turn.
  if (isActiveTurn) {
    return part.type;
  }
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

/**
 * Groups consecutive message parts for rendering. Image parts are grouped
 * together so they render as a row, and runs of agent activity (text /
 * thinking / tool parts that are NOT in `nonCollapsibleToolNames`) are
 * grouped under a `collapsible-agent-activity` type so the UI can collapse
 * them behind a single expander.
 *
 * Special cases:
 * - When `isActiveTurn` is true, nothing collapses: the user needs live
 *   visibility into the message the agent is currently executing. The
 *   "Finished working" disclosure only applies to historical activity that
 *   has been superseded by a newer agent message or a newer user turn.
 *   This flag is message-scoped, not thread-scoped — only the one agent
 *   message that the user is actively waiting on receives it.
 * - The last part of a message always renders as its own group (never
 *   collapses), so the most recent content is always visible.
 * - Anything at or after the last text part also never collapses, so
 *   trailing tool calls following the final assistant text stay expanded.
 */
export function groupParts({
  parts,
  isActiveTurn,
}: {
  parts: UIUserOrAgentPart[];
  /**
   * True only for the specific agent message that is currently executing
   * (i.e. `message.id === activeAgentMessageId && isAgentWorking`). When
   * a newer agent message or a newer user message arrives, the previous
   * agent message immediately flips to `isActiveTurn=false` and its
   * pre-final activity collapses under "Finished working".
   */
  isActiveTurn: boolean;
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
      isActiveTurn,
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

/**
 * Identify the agent message that the user is actively waiting on (the one
 * currently being executed). This id is message-scoped — ONLY this message
 * receives `isActiveTurn=true`, so all previous agent messages collapse
 * their pre-final activity under "Finished working" the moment a newer
 * agent message (or a newer user turn) supersedes them.
 *
 * Heuristic: the last agent message in the list qualifies IF it is also
 * the very last message overall (no newer user message superseding it)
 * AND the thread is currently working. As soon as the user sends a
 * follow-up, a new UIUserMessage is appended → this returns null → the
 * previous agent message flips to historical.
 */
export function getActiveAgentMessageId({
  messages,
  isAgentWorking,
}: {
  messages: UIMessage[];
  isAgentWorking: boolean;
}): string | null {
  if (!isAgentWorking) {
    return null;
  }
  // Find the latest agent message
  let latestAgentMessageIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "agent") {
      latestAgentMessageIndex = i;
      break;
    }
  }
  if (
    latestAgentMessageIndex === -1 ||
    latestAgentMessageIndex !== messages.length - 1
  ) {
    return null;
  }
  return messages[latestAgentMessageIndex]?.id ?? null;
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
