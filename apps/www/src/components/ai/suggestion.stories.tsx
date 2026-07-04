import type { Story, StoryDefault } from "@ladle/react";
import { Suggestion } from "./suggestion";

function Surface({ children }: { children: React.ReactNode }) {
  return <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>;
}

function SparkIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path
        d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"
        strokeLinecap="round"
      />
    </svg>
  );
}

const PROMPTS = [
  "Run the www test suite",
  "Open a PR against main",
  "Explain the delivery loop",
  "Fix the failing route.test.ts",
];

export const Variants: Story = () => (
  <Surface>
    <div className="flex flex-col items-start gap-3">
      <Suggestion variant="default">Add a follow-up task</Suggestion>
      <Suggestion variant="plain">Add a follow-up task</Suggestion>
      <Suggestion variant="list">Add a follow-up task</Suggestion>
    </div>
  </Surface>
);

export const ChipRow: Story = () => (
  <Surface>
    <div className="flex flex-wrap gap-2">
      {PROMPTS.map((prompt) => (
        <Suggestion key={prompt} variant="default">
          {prompt}
        </Suggestion>
      ))}
    </div>
  </Surface>
);

export const ListMenu: Story = () => (
  <Surface>
    <div className="w-72 rounded-outer bg-surface-elevated ring ring-border p-1">
      <div className="flex flex-col">
        {PROMPTS.map((prompt) => (
          <Suggestion key={prompt} variant="list" className="w-full">
            <SparkIcon />
            {prompt}
          </Suggestion>
        ))}
      </div>
    </div>
  </Surface>
);

export const ListSelected: Story = () => (
  <Surface>
    <div className="w-72 rounded-outer bg-surface-elevated ring ring-border p-1">
      <div className="flex flex-col">
        {PROMPTS.map((prompt, i) => (
          <Suggestion
            key={prompt}
            variant="list"
            className={i === 1 ? "w-full bg-accent text-foreground" : "w-full"}
            data-selected={i === 1 || undefined}
            aria-selected={i === 1}
          >
            <SparkIcon />
            {prompt}
          </Suggestion>
        ))}
      </div>
    </div>
  </Surface>
);

export const WithIcon: Story = () => (
  <Surface>
    <div className="flex flex-wrap gap-2">
      <Suggestion variant="default">
        <SparkIcon />
        Suggest a follow-up
      </Suggestion>
      <Suggestion variant="plain">
        <SparkIcon />
        Suggest a follow-up
      </Suggestion>
    </div>
  </Surface>
);

export const LongTextOverflow: Story = () => (
  <Surface>
    <div className="w-72 rounded-outer bg-surface-elevated ring ring-border p-1">
      <Suggestion variant="list" className="w-full">
        <SparkIcon />
        <span className="truncate">
          Investigate why route.test.ts history projection drifts when a new
          field is added to the messages fold
        </span>
      </Suggestion>
    </div>
  </Surface>
);

export default {
  title: "ai/suggestion",
} satisfies StoryDefault;
