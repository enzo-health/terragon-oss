"use client";

import { memo } from "react";
import { Sparkles } from "lucide-react";
import type { AIModel } from "@leo/agent/types";
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
      className="block rounded-xl transition-all duration-300 py-3 px-4 bg-white border border-border/30 shadow-outline-ring hover:shadow-card hover:scale-[1.01] w-full cursor-pointer text-left group"
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2.5">
          <div className="size-5 flex-shrink-0 flex items-center justify-center rounded-full bg-accent/50 group-hover:bg-accent transition-colors">
            <Sparkles className="size-3 text-muted-foreground/60" />
          </div>
          <p className="text-[14px] truncate font-medium text-foreground/80 font-sans tracking-[0.14px]">
            {task.label}
          </p>
        </div>
      </div>
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
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
