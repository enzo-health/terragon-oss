"use client";

import {
  Todo,
  TodoHeader,
  TodoItem,
  TodoItemIcon,
  TodoItemLabel,
  TodoList,
  TodoTitle,
} from "@/components/ai/todo";
import type { PlanEntry } from "../../transcript-store";
import type { Leaf } from "../leaf-props";

function todoStatus(
  status: PlanEntry["status"],
): "pending" | "progress" | "completed" {
  if (status === "completed") return "completed";
  if (status === "in_progress") return "progress";
  return "pending";
}

export const PlanLeaf: Leaf<"plan"> = ({ item }) => {
  const completed = item.entries.filter(
    (entry) => entry.status === "completed",
  ).length;

  return (
    <Todo defaultOpen className="my-2">
      <TodoHeader>
        <TodoTitle>
          Plan ({completed}/{item.entries.length})
        </TodoTitle>
      </TodoHeader>
      <TodoList className="pb-2">
        {item.entries.map((entry, index) => (
          <TodoItem key={entry.id ?? index} status={todoStatus(entry.status)}>
            <TodoItemIcon />
            <TodoItemLabel>{entry.content}</TodoItemLabel>
          </TodoItem>
        ))}
      </TodoList>
    </Todo>
  );
};
