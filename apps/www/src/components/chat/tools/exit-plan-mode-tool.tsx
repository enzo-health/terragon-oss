import React, { useCallback, useMemo, useState } from "react";
import { AllToolParts, DBMessage } from "@terragon/shared";
import { GenericToolPart } from "./generic-ui";
import { TextPart } from "../text-part";
import { Button } from "../../ui/button";
import { Check, Copy } from "lucide-react";
import { PromptBoxRef } from "../thread-context";
import { toast } from "sonner";
import { approvePlan } from "@/server-actions/approve-plan";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import { useOptimisticUpdateThreadChat } from "../hooks";

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
function formatPlanForDisplay(plan: string): string {
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

/**
 * Find the plan content from a recent Write tool call for a plans/*.md file.
 * This is used by newer agents that write the plan to a file before calling ExitPlanMode.
 */
function findPlanFromWriteToolCall({
  messages,
  exitPlanModeToolId,
}: {
  messages: DBMessage[] | null;
  exitPlanModeToolId: string;
}): string | null {
  if (!messages) return null;

  // Find the index of this ExitPlanMode tool call
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

  // Look backwards from the ExitPlanMode call for a Write tool call to plans/*.md
  for (let i = exitPlanModeIndex - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;

    // Stop if we hit a user message (different turn)
    if (message.type === "user") {
      break;
    }

    // Check if this is a Write tool call to a plans/*.md file
    if (message.type === "tool-call" && message.name === "Write") {
      const filePath = message.parameters?.file_path;
      if (typeof filePath === "string" && /plans\/[^/]+\.md$/.test(filePath)) {
        const content = message.parameters?.content;
        if (typeof content === "string" && content.trim()) {
          return content;
        }
      }
    }
  }

  return null;
}

export function ExitPlanModeTool({
  toolPart,
  threadId,
  threadChatId,
  messages,
  isReadOnly,
  promptBoxRef,
}: {
  toolPart: Extract<AllToolParts, { name: "ExitPlanMode" }>;
  threadId: string;
  threadChatId: string;
  messages: DBMessage[];
  isReadOnly: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
}) {
  // Try to get plan from parameters (old agent behavior) or from Write tool call (new agent behavior)
  const plan = useMemo(() => {
    let raw = "";
    // First check if plan is provided directly in parameters (old agent behavior)
    if (toolPart.parameters.plan) {
      raw = toolPart.parameters.plan;
    } else {
      // Otherwise, look for a recent Write tool call to plans/*.md
      raw =
        findPlanFromWriteToolCall({
          messages,
          exitPlanModeToolId: toolPart.id,
        }) || "";
    }
    // Parse JSON plans into readable markdown
    return formatPlanForDisplay(raw);
  }, [toolPart.parameters.plan, toolPart.id, messages]);
  const [copied, setCopied] = useState(false);
  const updateThreadChat = useOptimisticUpdateThreadChat({
    threadId,
    threadChatId,
  });
  // Only show buttons if this is the active ExitPlanMode tool
  const shouldShowButtons = useMemo(() => {
    if (isReadOnly) {
      return false;
    }
    // Calculate which ExitPlanMode tool should show buttons
    let lastExitPlanModeId: string | null = null;
    // Iterate backwards through messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!message) continue;
      // If we hit a user message, stop looking
      if (message.type === "user") {
        break;
      }
      if (message.type === "tool-call" && message.name === "ExitPlanMode") {
        lastExitPlanModeId = message.id;
        break;
      }
    }
    return lastExitPlanModeId === toolPart.id;
  }, [isReadOnly, messages, toolPart.id]);

  const handleApproveMutation = useServerActionMutation({
    mutationFn: approvePlan,
  });

  const handleApprove = useCallback(async () => {
    if (isReadOnly) {
      return;
    }
    // Switch promptbox to execute mode (allowAll)
    promptBoxRef?.current?.setPermissionMode("allowAll");
    updateThreadChat({ permissionMode: "allowAll" });
    await handleApproveMutation.mutateAsync({
      threadId,
      threadChatId,
    });
  }, [
    isReadOnly,
    threadId,
    threadChatId,
    promptBoxRef,
    handleApproveMutation,
    updateThreadChat,
  ]);

  const handleCopy = async () => {
    if (copied) {
      return;
    }
    try {
      await navigator.clipboard.writeText(plan);
      toast.success("Plan copied");
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (error) {
      toast.error("Failed to copy plan");
    }
  };

  // Show a placeholder if the plan is empty
  const displayPlan = plan || "(No plan content available)";

  return (
    <GenericToolPart toolName="Plan" toolArg="" toolStatus="completed">
      <div className="relative group">
        {plan && (
          <div className="absolute top-2 right-2 z-10">
            <Button
              variant="ghost"
              size="icon"
              className="size-7 bg-muted/80 hover:bg-muted"
              onClick={handleCopy}
              title="Copy plan"
            >
              {copied ? (
                <Check className="size-3" />
              ) : (
                <Copy className="size-3" />
              )}
            </Button>
          </div>
        )}
        <div className="p-3 bg-muted/50 rounded-md space-y-3">
          <div className="max-w-none font-sans pr-10">
            {plan ? (
              <TextPart text={plan} />
            ) : (
              <span className="text-muted-foreground italic">
                {displayPlan}
              </span>
            )}
          </div>
          {shouldShowButtons && (
            <div className="flex gap-2 pt-2">
              <Button
                size="sm"
                onClick={handleApprove}
                className="flex items-center gap-2 font-sans"
                disabled={handleApproveMutation.isPending}
              >
                <Check className="h-4 w-4" />
                Approve
              </Button>
            </div>
          )}
        </div>
      </div>
    </GenericToolPart>
  );
}
