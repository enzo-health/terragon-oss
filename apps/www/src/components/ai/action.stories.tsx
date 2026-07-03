import type { Story, StoryDefault } from "@ladle/react";
import {
  Action,
  ActionContent,
  ActionIcon,
  ActionLabel,
  ActionTrigger,
} from "./action";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const SearchIcon = () => (
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
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

export const CollapsedDefaultDot: Story = () => (
  <Surface>
    <Action>
      <ActionTrigger>
        <ActionIcon />
        <ActionLabel>Searched the codebase</ActionLabel>
      </ActionTrigger>
      <ActionContent>
        Found 12 matches for "TranscriptStore" across 4 files.
      </ActionContent>
    </Action>
  </Surface>
);

export const CollapsedCustomIcon: Story = () => (
  <Surface>
    <Action>
      <ActionTrigger>
        <ActionIcon>
          <SearchIcon />
        </ActionIcon>
        <ActionLabel>Grepped for useLiveTranscript</ActionLabel>
      </ActionTrigger>
      <ActionContent>
        apps/www/src/components/chat/transcript-view/use-live-transcript.ts:1
      </ActionContent>
    </Action>
  </Surface>
);

export const Expanded: Story = () => (
  <Surface>
    <Action defaultOpen>
      <ActionTrigger>
        <ActionIcon>
          <SearchIcon />
        </ActionIcon>
        <ActionLabel>Read 3 files</ActionLabel>
      </ActionTrigger>
      <ActionContent>
        <ul className="flex flex-col gap-1">
          <li>apps/www/src/components/ai/tool.tsx</li>
          <li>apps/www/src/components/ai/action.tsx</li>
          <li>apps/www/src/components/chat/transcript-view/registry.tsx</li>
        </ul>
      </ActionContent>
    </Action>
  </Surface>
);

export const ExpandedLongContent: Story = () => (
  <Surface>
    <Action defaultOpen>
      <ActionTrigger>
        <ActionIcon />
        <ActionLabel>Planned the refactor</ActionLabel>
      </ActionTrigger>
      <ActionContent>
        <p>
          The transcript renders through a pure TranscriptStore fold that maps
          AG-UI event envelopes onto a closed TranscriptItem union, which the
          typed leaf registry renders into the vendored nauval components. A new
          renderable agent event costs exactly three edits: the daemon provider
          adapter emits the terragon.part variant, the store fold adds one case,
          and the registry adds one line plus a leaf. Unknown parts fold to an
          unknown-part item and render a labeled fallback card rather than being
          dropped.
        </p>
      </ActionContent>
    </Action>
  </Surface>
);

export const Stacked: Story = () => (
  <Surface>
    <div className="flex flex-col gap-1">
      <Action>
        <ActionTrigger>
          <ActionIcon />
          <ActionLabel>Listed directory</ActionLabel>
        </ActionTrigger>
        <ActionContent>19 files in components/ai</ActionContent>
      </Action>
      <Action>
        <ActionTrigger>
          <ActionIcon>
            <SearchIcon />
          </ActionIcon>
          <ActionLabel>Searched for defaultOpen</ActionLabel>
        </ActionTrigger>
        <ActionContent>3 matches</ActionContent>
      </Action>
      <Action defaultOpen>
        <ActionTrigger>
          <ActionIcon />
          <ActionLabel>Read tool.tsx</ActionLabel>
        </ActionTrigger>
        <ActionContent>349 lines</ActionContent>
      </Action>
    </div>
  </Surface>
);

export default {
  title: "ai/action",
} satisfies StoryDefault;
