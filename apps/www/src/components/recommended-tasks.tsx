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
      className="group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-[background-color,color] duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className="flex-1 truncate text-[13px] font-medium text-mid group-hover:text-strong">
        {task.label}
      </span>
      <ArrowRight
        aria-hidden
        className="size-4 shrink-0 -translate-x-1 text-muted-foreground/40 transition-[color,transform] duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] group-hover:translate-x-0 group-hover:text-coral motion-reduce:transition-none"
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
    <ul className="flex w-full flex-col gap-0.5">
      {tasks.map((task) => (
        <li key={task.id}>
          <ListRecommendedTaskItem task={task} onTaskSelect={onTaskSelect} />
        </li>
      ))}
    </ul>
  );
}
