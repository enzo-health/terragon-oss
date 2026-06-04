"use client";

import { ArrowRight } from "lucide-react";
import type { AIModel } from "@terragon/agent/types";
import { tasksForModel } from "./recommended-tasks.utils";

interface RecommendedTask {
  id: string;
  label: string;
  prompt: string;
}

interface RecommendedTasksProps {
  onTaskSelect: (prompt: string) => void;
  selectedModel?: AIModel;
}

function ListRecommendedTaskItem({
  task,
  onTaskSelect,
}: {
  task: RecommendedTask;
  onTaskSelect: (prompt: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onTaskSelect(task.prompt)}
      className="group flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left transition-colors duration-[var(--duration-quick)] ease-[var(--ease-standard)] hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex-1 text-[14px] font-medium text-mid group-hover:text-strong">
        {task.label}
      </span>
      <ArrowRight
        aria-hidden
        className="size-4 shrink-0 -translate-x-1 text-muted-foreground/40 transition-[color,transform] duration-[var(--duration-quick)] ease-[var(--ease-standard)] group-hover:translate-x-0 group-hover:text-coral"
      />
    </button>
  );
}

export function RecommendedTasks({
  onTaskSelect,
  selectedModel,
}: RecommendedTasksProps) {
  const tasks = tasksForModel(selectedModel);

  return (
    <ul className="flex w-full flex-col divide-y divide-hairline-soft">
      {tasks.map((task) => (
        <li key={task.id}>
          <ListRecommendedTaskItem task={task} onTaskSelect={onTaskSelect} />
        </li>
      ))}
    </ul>
  );
}
