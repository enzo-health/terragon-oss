import type { Story, StoryDefault } from "@ladle/react";
import { RecommendedTasks } from "./recommended-tasks";

export default {
  title: "Components/RecommendedTasks",
} satisfies StoryDefault;

const SectionHeading = ({ children }: { children: React.ReactNode }) => (
  <h2 className="text-[12px] uppercase tracking-[0.13em] font-medium text-muted-foreground">
    {children}
  </h2>
);

export const Default: Story = () => {
  const handleTaskSelect = (prompt: string) => {
    console.log("Selected prompt:", prompt);
  };

  return (
    <div className="p-4 max-w-2xl space-y-3">
      <SectionHeading>Suggested tasks</SectionHeading>
      <RecommendedTasks onTaskSelect={handleTaskSelect} />
    </div>
  );
};

export const DarkMode: Story = () => {
  const handleTaskSelect = (prompt: string) => {
    console.log("Selected prompt:", prompt);
  };

  return (
    <div className="p-4 max-w-2xl dark bg-background space-y-3">
      <SectionHeading>Suggested tasks</SectionHeading>
      <RecommendedTasks onTaskSelect={handleTaskSelect} />
    </div>
  );
};

export const WithCustomHandler: Story = () => {
  const handleTaskSelect = (prompt: string) => {
    alert(`Selected prompt: ${prompt.substring(0, 50)}...`);
  };

  return (
    <div className="p-4 max-w-2xl space-y-3">
      <SectionHeading>Suggested tasks</SectionHeading>
      <RecommendedTasks onTaskSelect={handleTaskSelect} />
    </div>
  );
};
