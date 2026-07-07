import type { Story, StoryDefault } from "@ladle/react";
import { Mic } from "lucide-react";
import { Button } from "./button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

export const Basic: Story = () => (
  <Surface>
    <Tooltip>
      <TooltipTrigger render={<Button variant="secondary" />}>
        Hover me
      </TooltipTrigger>
      <TooltipPopup>Send message</TooltipPopup>
    </Tooltip>
  </Surface>
);

export const DefaultOpen: Story = () => (
  <Surface>
    <div className="pt-12">
      <Tooltip defaultOpen>
        <TooltipTrigger render={<Button variant="secondary" />}>
          Anchor
        </TooltipTrigger>
        <TooltipPopup>Dictate a message</TooltipPopup>
      </Tooltip>
    </div>
  </Surface>
);

export const OnIconButton: Story = () => (
  <Surface>
    <Tooltip>
      <TooltipTrigger
        render={<Button iconOnly variant="ghost" aria-label="Dictate" />}
      >
        <Mic />
      </TooltipTrigger>
      <TooltipPopup>Dictate a message</TooltipPopup>
    </Tooltip>
  </Surface>
);

export const Sides: Story = () => (
  <Surface>
    <div className="flex items-center justify-center gap-8 py-16">
      <Tooltip defaultOpen>
        <TooltipTrigger render={<Button variant="outline" />}>
          Top
        </TooltipTrigger>
        <TooltipPopup side="top">Above the trigger</TooltipPopup>
      </Tooltip>
      <Tooltip defaultOpen>
        <TooltipTrigger render={<Button variant="outline" />}>
          Bottom
        </TooltipTrigger>
        <TooltipPopup side="bottom">Below the trigger</TooltipPopup>
      </Tooltip>
      <Tooltip defaultOpen>
        <TooltipTrigger render={<Button variant="outline" />}>
          Left
        </TooltipTrigger>
        <TooltipPopup side="left">Left of the trigger</TooltipPopup>
      </Tooltip>
      <Tooltip defaultOpen>
        <TooltipTrigger render={<Button variant="outline" />}>
          Right
        </TooltipTrigger>
        <TooltipPopup side="right">Right of the trigger</TooltipPopup>
      </Tooltip>
    </div>
  </Surface>
);

export const RichContent: Story = () => (
  <Surface>
    <div className="pt-16">
      <Tooltip defaultOpen>
        <TooltipTrigger render={<Button variant="secondary" />}>
          claude-opus-4-8
        </TooltipTrigger>
        <TooltipPopup className="max-w-56">
          <div className="flex flex-col gap-1">
            <span className="font-medium">Claude Opus 4.8</span>
            <span className="text-background/70 text-xs">
              200k context · strongest reasoning, higher latency
            </span>
          </div>
        </TooltipPopup>
      </Tooltip>
    </div>
  </Surface>
);

export default {
  title: "ai/tooltip",
} satisfies StoryDefault;
