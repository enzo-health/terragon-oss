import type { DBMessage } from "@terragon/shared";

// Aliases matching parse-plan-spec.ts
const PLAN_TEXT_ALIASES = ["planText", "plan_text", "summary", "overview"];
const TASKS_ARRAY_ALIASES = ["tasks", "steps", "plan_tasks", "items"];
const TASK_TITLE_ALIASES = ["title", "name", "task_name", "label"];
const TASK_DESC_ALIASES = ["description", "details", "detail", "desc"];

function resolveKey(obj: Record<string, unknown>, aliases: string[]): unknown {
  const lower = new Map(
    Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]),
  );
  for (const a of aliases) {
    const val = lower.get(a.toLowerCase());
    if (val !== undefined) return val;
  }
  return undefined;
}

/**
 * If `plan` is JSON with planText/tasks, format it as markdown.
 * Otherwise return the raw string.
 */
export function formatPlanForDisplay(plan: string): string {
  const trimmed = plan.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return plan;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return plan;

    // Top-level array → treat as tasks list
    if (Array.isArray(parsed)) {
      return formatTasksAsMarkdown(null, parsed);
    }

    const obj = parsed as Record<string, unknown>;
    const planTextRaw = resolveKey(obj, PLAN_TEXT_ALIASES);
    const planText =
      typeof planTextRaw === "string" && planTextRaw.trim()
        ? planTextRaw.trim()
        : null;
    const tasksRaw = resolveKey(obj, TASKS_ARRAY_ALIASES);
    const tasks = Array.isArray(tasksRaw) ? tasksRaw : null;

    if (!planText && !tasks) return plan;
    return formatTasksAsMarkdown(planText, tasks);
  } catch {
    return plan;
  }
}

function formatTasksAsMarkdown(
  planText: string | null,
  tasks: unknown[] | null,
): string {
  const parts: string[] = [];
  if (planText) parts.push(planText);
  if (tasks && tasks.length > 0) {
    if (planText) parts.push("");
    parts.push("## Tasks");
    for (const task of tasks) {
      if (!task || typeof task !== "object") continue;
      const obj = task as Record<string, unknown>;
      const title = resolveKey(obj, TASK_TITLE_ALIASES);
      if (typeof title !== "string") continue;
      const desc = resolveKey(obj, TASK_DESC_ALIASES);
      parts.push(
        `- **${title}**${typeof desc === "string" ? ` — ${desc}` : ""}`,
      );
    }
  }
  return parts.join("\n");
}

export function resolvePlanTextFromLegacyMessages({
  planParam,
  messages,
  exitPlanModeToolId,
}: {
  planParam?: string;
  messages: DBMessage[] | null;
  exitPlanModeToolId: string;
}): string {
  let raw = "";
  const trimmedPlan = planParam?.trim();
  if (trimmedPlan) {
    raw = trimmedPlan;
  } else {
    raw =
      findPlanFromLegacyWriteToolCall({
        messages,
        exitPlanModeToolId,
      }) || "";
  }
  return formatPlanForDisplay(raw);
}

function findPlanFromLegacyWriteToolCall({
  messages,
  exitPlanModeToolId,
}: {
  messages: DBMessage[] | null;
  exitPlanModeToolId: string;
}): string | null {
  if (!messages) return null;

  let exitPlanModeIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message?.type === "tool-call" &&
      message.name === "ExitPlanMode" &&
      message.id === exitPlanModeToolId
    ) {
      exitPlanModeIndex = i;
      break;
    }
  }

  if (exitPlanModeIndex === -1) return null;

  for (let i = exitPlanModeIndex - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;

    if (message.type === "user") {
      break;
    }

    if (message.type === "tool-call" && message.name === "Write") {
      const filePath = message.parameters?.file_path;
      const content = message.parameters?.content;
      if (
        typeof filePath === "string" &&
        /plans\/[^/]+\.md$/.test(filePath) &&
        typeof content === "string" &&
        content.trim()
      ) {
        return content;
      }
    }
  }

  return null;
}
