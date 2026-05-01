"use client";

import { memo } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
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

const ListRecommendedTaskItem = memo(function ListRecommendedTaskItem({
  task,
  onTaskSelect,
}: {
  task: RecommendedTask;
  onTaskSelect: (prompt: string) => void;
}) {
  return (
    <button
      onClick={() => onTaskSelect(task.prompt)}
      className="group flex w-full items-center gap-3 rounded-lg px-4 py-3.5 text-left transition-[background-color,color] duration-150 hover:bg-surface-cream-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99]"
    >
      <Sparkles
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground transition-colors duration-200 group-hover:text-coral"
      />
      <span className="flex-1 text-[14px] font-medium text-foreground/85 group-hover:text-foreground">
        {task.label}
      </span>
      <ArrowRight
        aria-hidden
        className="size-4 shrink-0 -translate-x-1 text-transparent transition-[color,transform] duration-200 group-hover:translate-x-0 group-hover:text-coral"
      />
    </button>
  );
});

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
