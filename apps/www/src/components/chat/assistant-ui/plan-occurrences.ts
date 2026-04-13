import type { UIMessage, UIPart } from "@terragon/shared";
import { extractProposedPlanText } from "@terragon/shared/db/artifact-descriptors";

/**
 * Builds a thread-global plan occurrence map across all messages.
 * Mirrors the `planTextOccurrences` counter in `getArtifactDescriptors`
 * so that the render side can match descriptors by occurrence index.
 * Recurses into nested tool parts to match the descriptor traversal.
 */
export function buildThreadPlanOccurrenceMap(
  messages: UIMessage[],
): Map<UIPart, number> {
  const counts = new Map<string, number>();
  const result = new Map<UIPart, number>();

  function walkParts(parts: UIPart[]) {
    for (const part of parts) {
      if (part.type === "text") {
        const planText = extractProposedPlanText(
          (part as { text: string }).text,
        );
        if (planText) {
          const count = counts.get(planText) ?? 0;
          result.set(part, count);
          counts.set(planText, count + 1);
        }
      } else if (part.type === "tool" && "parts" in part) {
        walkParts((part as { parts: UIPart[] }).parts);
      }
    }
  }

  for (const message of messages) {
    if (message.role !== "agent") continue;
    walkParts(message.parts);
  }
  return result;
}
