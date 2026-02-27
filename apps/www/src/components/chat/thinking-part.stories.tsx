import type { Story, StoryDefault } from "@ladle/react";
import { ThinkingPart } from "./thinking-part";

export default {
  title: "Chat/ThinkingPart",
} satisfies StoryDefault;

export const SimpleText: Story = () => {
  return (
    <div className="p-4 max-w-4xl">
      <ThinkingPart thinking="This is a simple text message without any markdown formatting." />
    </div>
  );
};

export const OverflowTest: Story = () => {
  const longCodeThinking = `Looking at the Button component's outline variant on line 16-17:

outline:
  'border bg-background shadow-xs hover:bg-muted/50 hover:text-muted-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50',

The key hover styles for outline variant are:
- hover:bg-muted/50 (50% opacity of muted background)
- hover:text-muted-foreground (changes text color to muted-foreground)
- In dark mode: dark:hover:bg-input/50

So I need to update the header button to use hover:bg-muted/50 instead of hover:bg-accent to match the Create Environment button.`;

  return (
    <div className="p-4 max-w-xl border border-red-500">
      <div className="text-xs text-red-500 mb-2">
        Container with max-width to test overflow
      </div>
      <ThinkingPart thinking={longCodeThinking} />
    </div>
  );
};
