import type { AIModel } from "@leo/agent/types";
import { modelToAgent } from "@leo/agent/utils";

interface RecommendedTask {
  id: string;
  label: string;
  prompt: string;
}

const COMMON_RECOMMENDED_TASKS: RecommendedTask[] = [
  {
    id: "improve-test-coverage",
    label: "Improve test coverage",
    prompt:
      "Find the most recently modified function or component that lacks tests and write a comprehensive test for it. Use the existing testing framework and verify the test passes.",
  },
  {
    id: "find-bugs-todos",
    label: "Find potential bugs and TODOs",
    prompt:
      "Check the most recently modified files one by one for TODO comments, FIXME notes, or potential bugs (like missing error handling, null checks, or type safety issues). Stop when you find the first issue and fix it.",
  },
];

const CLAUDE_UPDATE_TASK: RecommendedTask = {
  id: "update-claude-md",
  label: "Update CLAUDE.md",
  prompt:
    "Update the CLAUDE.md file to reflect the current state of the codebase. This includes updating the codebase description, the codebase structure, and the codebase dependencies.",
};

const OTHER_AGENTS_UPDATE_TASK: RecommendedTask = {
  id: "update-agents-md",
  label: "Update AGENTS.md",
  prompt:
    "Update the AGENTS.md file to reflect the current state of the codebase. This includes updating the codebase description, the codebase structure, and the codebase dependencies.",
};

/**
 * Returns the appropriate task recommendations based on the AI model.
 * Claude models get CLAUDE.md task, all other agents get AGENTS.md task.
 * The other tasks are common to both model types.
 */
export function tasksForModel(model: AIModel | undefined): RecommendedTask[] {
  const updateTask =
    model && modelToAgent(model) === "claudeCode"
      ? CLAUDE_UPDATE_TASK
      : OTHER_AGENTS_UPDATE_TASK;

  return [updateTask, ...COMMON_RECOMMENDED_TASKS];
}
