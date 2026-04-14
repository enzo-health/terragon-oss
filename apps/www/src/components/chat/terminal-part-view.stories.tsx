import type { Story, StoryDefault } from "@ladle/react";
import { TerminalPartView } from "./terminal-part-view";
import type { DBTerminalPart } from "@terragon/shared";

export default {
  title: "Chat/TerminalPartView",
} satisfies StoryDefault;

const basePart: DBTerminalPart = {
  type: "terminal",
  sandboxId: "sandbox-abc123def",
  terminalId: "term-1",
  chunks: [],
};

export const MixedOutput: Story = () => (
  <div className="p-4 max-w-xl">
    <TerminalPartView
      part={{
        ...basePart,
        chunks: [
          { streamSeq: 0, kind: "stdout", text: "$ npm install\n" },
          { streamSeq: 1, kind: "stdout", text: "added 42 packages in 1.5s\n" },
          {
            streamSeq: 2,
            kind: "stderr",
            text: "warning: deprecated package\n",
          },
          { streamSeq: 3, kind: "interaction", text: "Continue? [Y/n] " },
          { streamSeq: 4, kind: "stdout", text: "Y\n" },
        ],
      }}
    />
  </div>
);

export const Empty: Story = () => (
  <div className="p-4 max-w-xl">
    <TerminalPartView part={basePart} />
  </div>
);
