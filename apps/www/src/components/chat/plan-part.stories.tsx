import type { Story, StoryDefault } from "@ladle/react";
import { PlanPartView } from "./plan-part";
import type { DBPlanPart } from "@terragon/shared";

export default {
  title: "Chat/PlanPartView",
} satisfies StoryDefault;

export const AllStatuses: Story = () => {
  const part: DBPlanPart = {
    type: "plan",
    entries: [
      {
        id: "1",
        content: "Set up authentication module",
        priority: "high",
        status: "completed",
      },
      {
        id: "2",
        content: "Implement JWT validation",
        priority: "high",
        status: "in_progress",
      },
      {
        id: "3",
        content: "Add refresh token rotation",
        priority: "medium",
        status: "pending",
      },
      {
        id: "4",
        content: "Write unit tests",
        priority: "medium",
        status: "pending",
      },
      {
        id: "5",
        content: "Update API documentation",
        priority: "low",
        status: "pending",
      },
    ],
  };
  return (
    <div className="p-4 max-w-lg">
      <PlanPartView part={part} />
    </div>
  );
};

export const AllHighPriority: Story = () => {
  const part: DBPlanPart = {
    type: "plan",
    entries: [
      {
        id: "1",
        content: "Critical fix: resolve null pointer",
        priority: "high",
        status: "in_progress",
      },
      {
        id: "2",
        content: "Critical: security patch",
        priority: "high",
        status: "pending",
      },
    ],
  };
  return (
    <div className="p-4 max-w-lg">
      <PlanPartView part={part} />
    </div>
  );
};

export const Empty: Story = () => (
  <div className="p-4 max-w-lg">
    <PlanPartView part={{ type: "plan", entries: [] }} />
  </div>
);
