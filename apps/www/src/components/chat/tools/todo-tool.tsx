import React from "react";
import { AllToolParts } from "@leo/shared";
import { cn } from "@/lib/utils";
import {
  GenericToolPartContent,
  GenericToolPartContentOneLine,
  GenericToolPart,
} from "./generic-ui";

export function TodoReadTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "TodoRead" }>;
}) {
  if (toolPart.status === "error") {
    return (
      <GenericToolPart
        toolName="Read Todos"
        toolArg={null}
        toolStatus={toolPart.status}
      >
        <GenericToolPartContentOneLine toolStatus="error">
          □ Failed to read todo list
        </GenericToolPartContentOneLine>
      </GenericToolPart>
    );
  }

  return null;
}

function TodoProgressBar({ todos }: { todos: { status: string }[] }) {
  const total = todos.length;
  if (total === 0) return null;
  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  const pct = Math.round((completed / total) * 100);
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-green-500 rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 tabular-nums">
        {completed}/{total}
        {inProgress > 0 && ` (${inProgress} active)`}
      </span>
    </div>
  );
}

export function TodoWriteTool({
  toolPart,
}: {
  toolPart: Extract<AllToolParts, { name: "TodoWrite" }>;
}) {
  if (toolPart.status === "pending") {
    return (
      <GenericToolPart
        toolName="Update Todos"
        toolArg={null}
        toolStatus={toolPart.status}
      >
        <GenericToolPartContentOneLine toolStatus="pending">
          Updating todo list...
        </GenericToolPartContentOneLine>
      </GenericToolPart>
    );
  }
  if (toolPart.status === "error") {
    return (
      <GenericToolPart
        toolName="Update Todos"
        toolArg={null}
        toolStatus={toolPart.status}
      >
        <GenericToolPartContentOneLine toolStatus="error">
          □ Failed to update todo list
        </GenericToolPartContentOneLine>
      </GenericToolPart>
    );
  }
  return (
    <GenericToolPart
      toolName="Update Todos"
      toolArg={null}
      toolStatus={toolPart.status}
    >
      <TodoProgressBar todos={toolPart.parameters.todos} />
      <GenericToolPartContent
        toolStatus={toolPart.status}
        className="grid-cols-[auto_auto_1fr]"
      >
        {toolPart.parameters.todos.map((todo, index) => (
          <React.Fragment key={index}>
            <span>{index === 0 ? "└" : " "}</span>
            <span
              className={cn({
                "text-muted-foreground": todo.status === "pending",
              })}
            >
              {todo.status === "completed"
                ? "☒"
                : todo.status === "in_progress"
                  ? "◼"
                  : "□"}
            </span>
            <span
              className={cn({
                "line-through text-muted-foreground":
                  todo.status === "completed",
                "font-semibold": todo.status === "in_progress",
              })}
            >
              {todo.content}
            </span>
          </React.Fragment>
        ))}
      </GenericToolPartContent>
    </GenericToolPart>
  );
}
