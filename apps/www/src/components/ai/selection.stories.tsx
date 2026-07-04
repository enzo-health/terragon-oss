import type { Story, StoryDefault } from "@ladle/react";
import {
  Selection,
  SelectionButton,
  SelectionContent,
  SelectionSeparator,
  SelectionToolbar,
} from "./selection";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const Hint = () => (
  <p className="mb-3 text-xs text-muted-foreground">
    Select any text below to reveal the toolbar.
  </p>
);

const Prose = () => (
  <SelectionContent className="prose-sm max-w-none text-sm leading-6 text-foreground">
    <p>
      The transcript renders through a pure TranscriptStore fold: AG-UI event
      envelopes collapse into a closed TranscriptItem union, and a typed leaf
      registry maps each kind to exactly one nauval component.
    </p>
    <p className="mt-3">
      A new renderable agent event costs exactly three edits: the daemon adapter
      emits the terragon.part variant, the store fold adds one case, and the
      registry adds one line plus a leaf. Unknown parts fold to a labeled
      fallback card and are never dropped.
    </p>
  </SelectionContent>
);

export const Default: Story = () => (
  <Surface>
    <Hint />
    <Selection>
      <Prose />
      <SelectionToolbar>
        <SelectionButton onSelect={(text) => console.log("copy", text)}>
          Copy
        </SelectionButton>
        <SelectionSeparator />
        <SelectionButton onSelect={(text) => console.log("quote", text)}>
          Quote
        </SelectionButton>
      </SelectionToolbar>
    </Selection>
  </Surface>
);

export const ManyActions: Story = () => (
  <Surface>
    <Hint />
    <Selection>
      <Prose />
      <SelectionToolbar>
        <SelectionButton onSelect={(text) => console.log("copy", text)}>
          Copy
        </SelectionButton>
        <SelectionButton onSelect={(text) => console.log("quote", text)}>
          Quote
        </SelectionButton>
        <SelectionSeparator />
        <SelectionButton onSelect={(text) => console.log("explain", text)}>
          Explain
        </SelectionButton>
        <SelectionButton
          variant="primary"
          onSelect={(text) => console.log("ask", text)}
        >
          Ask agent
        </SelectionButton>
      </SelectionToolbar>
    </Selection>
  </Surface>
);

export const BottomSide: Story = () => (
  <Surface>
    <Hint />
    <Selection>
      <Prose />
      <SelectionToolbar side="bottom">
        <SelectionButton onSelect={(text) => console.log("copy", text)}>
          Copy
        </SelectionButton>
        <SelectionSeparator />
        <SelectionButton onSelect={(text) => console.log("quote", text)}>
          Quote
        </SelectionButton>
      </SelectionToolbar>
    </Selection>
  </Surface>
);

export const CenterAligned: Story = () => (
  <Surface>
    <Hint />
    <Selection>
      <Prose />
      <SelectionToolbar align="center">
        <SelectionButton onSelect={(text) => console.log("copy", text)}>
          Copy
        </SelectionButton>
        <SelectionSeparator />
        <SelectionButton onSelect={(text) => console.log("quote", text)}>
          Quote
        </SelectionButton>
      </SelectionToolbar>
    </Selection>
  </Surface>
);

export default {
  title: "ai/selection",
} satisfies StoryDefault;
