"use client";

import { memo } from "react";
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
  const handleClick = () => {
    onTaskSelect(task.prompt);
  };

  return (
    <button
      onClick={handleClick}
      className="w-full cursor-pointer text-left group py-1.5 px-1 rounded-md hover:bg-accent/50 transition-colors"
    >
      <span className="text-sm text-foreground/80 font-sans">{task.label}</span>
    </button>
  );
});

export function RecommendedTasks({
  onTaskSelect,
  selectedModel,
}: RecommendedTasksProps) {
  // Select tasks based on the model's agent type
  const tasks = tasksForModel(selectedModel);

  return (
    <div className="w-full">
      <div className="flex flex-col gap-1">
        {tasks.map((task) => (
          <ListRecommendedTaskItem
            key={task.id}
            task={task}
            onTaskSelect={onTaskSelect}
          />
        ))}
      </div>
    </div>
  );
}
