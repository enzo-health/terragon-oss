import type { Story, StoryDefault } from "@ladle/react";
import { Task, TaskIcon, TaskItem, TaskLabel } from "./task";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const CheckIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const SpinnerIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className="animate-spin"
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

export const SingleItem: Story = () => (
  <Surface>
    <Task>
      <TaskItem>
        <TaskIcon />
        <TaskLabel>Read the transcript store fold</TaskLabel>
      </TaskItem>
    </Task>
  </Surface>
);

export const DefaultDotIcons: Story = () => (
  <Surface>
    <Task>
      <TaskItem>
        <TaskIcon />
        <TaskLabel>Vendored the nauval components</TaskLabel>
      </TaskItem>
      <TaskItem>
        <TaskIcon />
        <TaskLabel>Re-themed onto Terragon tokens</TaskLabel>
      </TaskItem>
      <TaskItem>
        <TaskIcon />
        <TaskLabel>Wrote Ladle stories</TaskLabel>
      </TaskItem>
    </Task>
  </Surface>
);

export const MixedStatusIcons: Story = () => (
  <Surface>
    <Task>
      <TaskItem>
        <TaskIcon className="text-success">
          <CheckIcon />
        </TaskIcon>
        <TaskLabel>Cloned the repository</TaskLabel>
      </TaskItem>
      <TaskItem>
        <TaskIcon className="text-success">
          <CheckIcon />
        </TaskIcon>
        <TaskLabel>Installed dependencies</TaskLabel>
      </TaskItem>
      <TaskItem>
        <TaskIcon className="text-inflight">
          <SpinnerIcon />
        </TaskIcon>
        <TaskLabel>Running the test suite</TaskLabel>
      </TaskItem>
      <TaskItem>
        <TaskIcon />
        <TaskLabel>Open a pull request</TaskLabel>
      </TaskItem>
    </Task>
  </Surface>
);

export const RichLabels: Story = () => (
  <Surface>
    <Task>
      <TaskItem>
        <TaskIcon className="text-success">
          <CheckIcon />
        </TaskIcon>
        <TaskLabel>
          Edited <code className="font-mono text-xs">registry.tsx</code>
        </TaskLabel>
      </TaskItem>
      <TaskItem>
        <TaskIcon className="text-success">
          <CheckIcon />
        </TaskIcon>
        <TaskLabel>
          Ran <code className="font-mono text-xs">pnpm -C apps/www test</code>
        </TaskLabel>
      </TaskItem>
    </Task>
  </Surface>
);

export const LongLabel: Story = () => (
  <Surface>
    <Task>
      <TaskItem>
        <TaskIcon className="text-success">
          <CheckIcon />
        </TaskIcon>
        <TaskLabel>
          Refactored the transcript view registry so every TranscriptItem kind
          maps to exactly one nauval leaf via a Record over the closed union,
          preserving the compile-time exhaustiveness check across all sixteen
          kinds
        </TaskLabel>
      </TaskItem>
      <TaskItem>
        <TaskIcon />
        <TaskLabel>Verify the exhaustiveness check still compiles</TaskLabel>
      </TaskItem>
    </Task>
  </Surface>
);

export default {
  title: "ai/task",
} satisfies StoryDefault;
