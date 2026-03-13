"use client";

import { memo } from "react";
import { Sparkles } from "lucide-react";
import type { AIModel } from "@terragon/agent/types";
import { tasksForModel } from "./recommended-tasks.utils";
import { usePostHog } from "posthog-js/react";

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
  selectedModel,
}: {
  task: RecommendedTask;
  onTaskSelect: (prompt: string) => void;
  selectedModel?: AIModel;
}) {
  const posthog = usePostHog();

  const handleClick = () => {
    posthog?.capture("recommended_task_clicked", {
      taskLabel: task.label,
      selectedModel: selectedModel,
    });

    onTaskSelect(task.prompt);
  };

  return (
    <button
      onClick={handleClick}
      className="block rounded-md transition-colors py-2 hover:bg-muted/50 w-full cursor-pointer"
    >
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 flex-shrink-0 flex items-center justify-center">
            <Sparkles className="size-3 text-muted-foreground/50" />
          </div>
          <p className="text-sm truncate font-medium text-muted-foreground/50">
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
      <div className="space-y-0">
        {tasks.map((task) => (
          <ListRecommendedTaskItem
            key={task.id}
            task={task}
            onTaskSelect={onTaskSelect}
            selectedModel={selectedModel}
          />
        ))}
      </div>
    </div>
  );
}
