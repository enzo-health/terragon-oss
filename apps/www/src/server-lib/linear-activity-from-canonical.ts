import type { DBMessage } from "@terragon/shared";
import type { AgentPlanStep } from "@/server-lib/linear-agent-activity";

export const LINEAR_ACTIVITY_SUMMARY_MAX_CHARS = 200;

export function extractLastAssistantTextFromDBMessages(
  messages: readonly DBMessage[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.type !== "agent") {
      continue;
    }
    for (const part of message.parts) {
      if (part.type === "text" && part.text.trim()) {
        return part.text.slice(0, LINEAR_ACTIVITY_SUMMARY_MAX_CHARS);
      }
    }
  }
  return null;
}

export function extractLatestAgentPlanFromDBMessages(
  messages: readonly DBMessage[],
): AgentPlanStep[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.type !== "agent") {
      continue;
    }
    for (const part of message.parts) {
      if (part.type !== "plan") {
        continue;
      }
      return part.entries.map((entry) => ({
        content: entry.content,
        status:
          entry.status === "in_progress"
            ? "inProgress"
            : entry.status === "completed"
              ? "completed"
              : "pending",
      }));
    }
  }
  return null;
}
