import type { Story, StoryDefault } from "@ladle/react";
import { Button } from "./button";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "./popover";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

export const Basic: Story = () => (
  <Surface>
    <Popover>
      <PopoverTrigger render={<Button variant="secondary" />}>
        Open popover
      </PopoverTrigger>
      <PopoverPopup>
        <PopoverTitle>Sandbox ready</PopoverTitle>
        <PopoverDescription>
          The dev environment finished booting and the agent is connected.
        </PopoverDescription>
      </PopoverPopup>
    </Popover>
  </Surface>
);

export const DefaultOpen: Story = () => (
  <Surface>
    <div className="pt-24">
      <Popover defaultOpen>
        <PopoverTrigger render={<Button variant="secondary" />}>
          Anchor
        </PopoverTrigger>
        <PopoverPopup className="max-w-xs">
          <PopoverTitle>Rate limit</PopoverTitle>
          <PopoverDescription>
            You have used 182k of 200k tokens this five-hour window. Usage
            resets at 14:00 UTC.
          </PopoverDescription>
        </PopoverPopup>
      </Popover>
    </div>
  </Surface>
);

export const WithActions: Story = () => (
  <Surface>
    <div className="pt-24">
      <Popover defaultOpen>
        <PopoverTrigger render={<Button variant="outline" />}>
          Discard changes
        </PopoverTrigger>
        <PopoverPopup className="max-w-xs">
          <PopoverTitle>Discard uncommitted changes?</PopoverTitle>
          <PopoverDescription>
            This resets the working tree to the last commit and cannot be
            undone.
          </PopoverDescription>
          <div className="mt-2 flex items-center gap-2 self-end">
            <Button variant="ghost">Cancel</Button>
            <Button variant="primary">Discard</Button>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  </Surface>
);

export const Sides: Story = () => (
  <Surface>
    <div className="flex items-center justify-center gap-6 py-28">
      <Popover defaultOpen>
        <PopoverTrigger render={<Button variant="outline" />}>
          Top
        </PopoverTrigger>
        <PopoverPopup side="top">
          <PopoverDescription>Positioned above</PopoverDescription>
        </PopoverPopup>
      </Popover>
      <Popover defaultOpen>
        <PopoverTrigger render={<Button variant="outline" />}>
          Bottom
        </PopoverTrigger>
        <PopoverPopup side="bottom">
          <PopoverDescription>Positioned below</PopoverDescription>
        </PopoverPopup>
      </Popover>
    </div>
  </Surface>
);

export const LongContentOverflow: Story = () => (
  <Surface>
    <div className="pt-24">
      <Popover defaultOpen>
        <PopoverTrigger render={<Button variant="secondary" />}>
          PR description
        </PopoverTrigger>
        <PopoverPopup className="max-w-sm">
          <PopoverTitle>Generated PR description</PopoverTitle>
          <PopoverDescription className="max-h-40 overflow-y-auto">
            This change stabilizes ACP session continuity across turns by
            reading the trusted POST response in addition to the SSE echo, so a
            dropped stream no longer strands a thread in the working state. It
            also fences terminal recovery at the daemon-event route, migrates
            the concurrency kick, and adds a reconcile-ack path for duplicate
            stop requests. The resume policy now defaults to
            server-authoritative run liveness, and the run lifecycle is the sole
            completion authority.
          </PopoverDescription>
        </PopoverPopup>
      </Popover>
    </div>
  </Surface>
);

export default {
  title: "ai/popover",
} satisfies StoryDefault;
