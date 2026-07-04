import type { Story, StoryDefault } from "@ladle/react";
import { ArrowUp, Check, GitBranch, Plus, Trash2 } from "lucide-react";
import { Button } from "./button";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

export const Primary: Story = () => (
  <Surface>
    <Button>Send message</Button>
  </Surface>
);

export const Variants: Story = () => (
  <Surface>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary">Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="outline">Outline</Button>
    </div>
  </Surface>
);

export const WithLeadingIcon: Story = () => (
  <Surface>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary">
        <ArrowUp />
        Send
      </Button>
      <Button variant="secondary">
        <GitBranch />
        Create branch
      </Button>
      <Button variant="outline">
        <Check />
        Approve
      </Button>
    </div>
  </Surface>
);

export const IconOnly: Story = () => (
  <Surface>
    <div className="flex flex-wrap items-center gap-2">
      <Button iconOnly variant="primary" aria-label="Send">
        <ArrowUp />
      </Button>
      <Button iconOnly variant="secondary" aria-label="Add">
        <Plus />
      </Button>
      <Button iconOnly variant="ghost" aria-label="Delete">
        <Trash2 />
      </Button>
      <Button iconOnly variant="outline" aria-label="New branch">
        <GitBranch />
      </Button>
    </div>
  </Surface>
);

export const RoundSubmit: Story = () => (
  <Surface>
    <Button
      iconOnly
      variant="primary"
      className="rounded-full"
      aria-label="Send"
    >
      <ArrowUp />
    </Button>
  </Surface>
);

export const Loading: Story = () => (
  <Surface>
    <div className="flex flex-wrap items-center gap-2">
      <Button loading variant="primary">
        Committing
      </Button>
      <Button loading variant="secondary">
        Pushing
      </Button>
      <Button loading iconOnly variant="outline" aria-label="Working">
        <ArrowUp />
      </Button>
    </div>
  </Surface>
);

export const NotLoading: Story = () => (
  <Surface>
    <Button loading={false}>
      <Check />
      Ready
    </Button>
  </Surface>
);

export const Disabled: Story = () => (
  <Surface>
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled variant="primary">
        Send
      </Button>
      <Button disabled variant="secondary">
        Retry
      </Button>
      <Button disabled iconOnly variant="ghost" aria-label="Delete">
        <Trash2 />
      </Button>
    </div>
  </Surface>
);

export const AllVariantsGrid: Story = () => (
  <Surface>
    <div className="grid grid-cols-[auto_1fr_1fr_1fr] items-center gap-3 text-sm">
      <span className="text-muted-foreground">default</span>
      <Button variant="primary">Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <span className="text-muted-foreground">loading</span>
      <Button loading variant="primary">
        Primary
      </Button>
      <Button loading variant="secondary">
        Secondary
      </Button>
      <Button loading variant="ghost">
        Ghost
      </Button>
      <span className="text-muted-foreground">disabled</span>
      <Button disabled variant="primary">
        Primary
      </Button>
      <Button disabled variant="secondary">
        Secondary
      </Button>
      <Button disabled variant="ghost">
        Ghost
      </Button>
    </div>
  </Surface>
);

export const LongLabelOverflow: Story = () => (
  <Surface>
    <div className="max-w-56">
      <Button className="w-full">
        <GitBranch />
        <span className="truncate">
          Create pull request from chore/aa into main branch
        </span>
      </Button>
    </div>
  </Surface>
);

export default {
  title: "ai/button",
} satisfies StoryDefault;
