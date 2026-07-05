import type { Story, StoryDefault } from "@ladle/react";
import { LeafLoading } from "./leaf-loading";

export const Default: Story = () => {
  return (
    <div className="p-4">
      <LeafLoading />
    </div>
  );
};

export const CustomMessage: Story = () => {
  return (
    <div className="p-4">
      <LeafLoading message="Thinking" />
    </div>
  );
};

export const LongMessage: Story = () => {
  return (
    <div className="p-4">
      <LeafLoading message="Processing your request and analyzing the codebase" />
    </div>
  );
};

export const DarkMode: Story = () => {
  return (
    <div className="dark bg-background p-4">
      <LeafLoading message="Assistant is working" />
    </div>
  );
};

export const MultipleStates: Story = () => {
  return (
    <div className="space-y-4 p-4">
      <LeafLoading message="Booting environment" />
      <LeafLoading message="Cloning repository" />
      <LeafLoading message="Installing agent" />
      <LeafLoading message="Running setup script" />
      <LeafLoading message="Assistant is working" />
    </div>
  );
};

export default {
  title: "Chat/Leaf Loading",
} satisfies StoryDefault;
