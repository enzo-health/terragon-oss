import type { Story, StoryDefault } from "@ladle/react";
import {
  Tool,
  ToolArgument,
  ToolBlock,
  ToolContent,
  ToolError,
  ToolIcon,
  ToolLabel,
  ToolName,
  ToolSubtitle,
  ToolTrigger,
} from "./tool";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const TerminalIcon = () => (
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
    <path d="m4 17 6-6-6-6" />
    <path d="M12 19h8" />
  </svg>
);

const bashArgs = JSON.stringify(
  {
    command: "pnpm -C apps/www test src/components/chat",
    description: "Run chat component tests",
  },
  null,
  2,
);

const editArgs = JSON.stringify({
  file_path: "apps/www/src/components/chat/transcript-view/registry.tsx",
  old_string: "const registry = {}",
  new_string: "const registry = { text: TextLeaf }",
});

export const Pending: Story = () => (
  <Surface>
    <Tool state="pending">
      <ToolTrigger>
        <ToolIcon>
          <TerminalIcon />
        </ToolIcon>
        <ToolName>Bash</ToolName>
        <ToolLabel>Waiting to start</ToolLabel>
      </ToolTrigger>
    </Tool>
  </Surface>
);

export const Approval: Story = () => (
  <Surface>
    <Tool state="approval" defaultOpen>
      <ToolTrigger>
        <ToolIcon>
          <TerminalIcon />
        </ToolIcon>
        <ToolName>Bash</ToolName>
        <ToolLabel>Needs approval</ToolLabel>
      </ToolTrigger>
      <ToolContent>
        <ToolSubtitle>Command</ToolSubtitle>
        <ToolArgument value={bashArgs} state="complete" />
      </ToolContent>
    </Tool>
  </Surface>
);

export const Running: Story = () => (
  <Surface>
    <Tool state="running" defaultOpen>
      <ToolTrigger>
        <ToolIcon>
          <TerminalIcon />
        </ToolIcon>
        <ToolName>Bash</ToolName>
        <ToolLabel>Running</ToolLabel>
      </ToolTrigger>
      <ToolContent>
        <ToolSubtitle>Command</ToolSubtitle>
        <ToolArgument value={bashArgs} state="complete" />
      </ToolContent>
    </Tool>
  </Surface>
);

export const RunningCollapsed: Story = () => (
  <Surface>
    <Tool state="running">
      <ToolTrigger>
        <ToolIcon>
          <TerminalIcon />
        </ToolIcon>
        <ToolName>Bash</ToolName>
        <ToolLabel>pnpm install</ToolLabel>
      </ToolTrigger>
      <ToolContent>
        <ToolSubtitle>Command</ToolSubtitle>
        <ToolArgument value={bashArgs} state="complete" />
      </ToolContent>
    </Tool>
  </Surface>
);

export const Success: Story = () => (
  <Surface>
    <Tool state="success" defaultOpen>
      <ToolTrigger>
        <ToolIcon>
          <TerminalIcon />
        </ToolIcon>
        <ToolName>Bash</ToolName>
        <ToolLabel>Exited 0</ToolLabel>
      </ToolTrigger>
      <ToolContent>
        <ToolSubtitle>Command</ToolSubtitle>
        <ToolArgument value={bashArgs} state="complete" />
        <ToolSubtitle>Output</ToolSubtitle>
        <ToolBlock>{`Test Files  4 passed (4)
     Tests  27 passed (27)
  Start at  10:14:22
  Duration  1.84s`}</ToolBlock>
      </ToolContent>
    </Tool>
  </Surface>
);

export const Error: Story = () => (
  <Surface>
    <Tool state="error" defaultOpen>
      <ToolTrigger>
        <ToolIcon>
          <TerminalIcon />
        </ToolIcon>
        <ToolName>Bash</ToolName>
        <ToolLabel>Exited 1</ToolLabel>
      </ToolTrigger>
      <ToolContent>
        <ToolSubtitle>Command</ToolSubtitle>
        <ToolArgument value={bashArgs} state="complete" />
        <ToolError>{`error TS2345: Argument of type 'string' is not assignable to parameter of type 'TranscriptItem'.
  at registry.tsx:42:18`}</ToolError>
      </ToolContent>
    </Tool>
  </Surface>
);

export const ArgumentStreaming: Story = () => (
  <Surface>
    <Tool state="running" defaultOpen>
      <ToolTrigger>
        <ToolIcon>
          <TerminalIcon />
        </ToolIcon>
        <ToolName>Edit</ToolName>
        <ToolLabel>Streaming arguments</ToolLabel>
      </ToolTrigger>
      <ToolContent>
        <ToolSubtitle>Arguments</ToolSubtitle>
        <ToolArgument
          value={`{"file_path":"apps/www/src/lib/uti`}
          state="streaming"
        />
      </ToolContent>
    </Tool>
  </Surface>
);

export const ArgumentStreamingScalar: Story = () => (
  <Surface>
    <Tool state="running" defaultOpen>
      <ToolTrigger>
        <ToolIcon>
          <TerminalIcon />
        </ToolIcon>
        <ToolName>Read</ToolName>
        <ToolLabel>Streaming path</ToolLabel>
      </ToolTrigger>
      <ToolContent>
        <ToolSubtitle>Arguments</ToolSubtitle>
        <ToolArgument
          value={`"apps/www/src/components/ai/too`}
          state="streaming"
        />
      </ToolContent>
    </Tool>
  </Surface>
);

export const ArgumentObject: Story = () => (
  <Surface>
    <Tool state="success" defaultOpen>
      <ToolTrigger>
        <ToolIcon>
          <TerminalIcon />
        </ToolIcon>
        <ToolName>Edit</ToolName>
        <ToolLabel>utils.ts</ToolLabel>
      </ToolTrigger>
      <ToolContent>
        <ToolSubtitle>Arguments</ToolSubtitle>
        <ToolArgument value={editArgs} state="complete" />
      </ToolContent>
    </Tool>
  </Surface>
);

export const ArgumentScalar: Story = () => (
  <Surface>
    <Tool state="success" defaultOpen>
      <ToolTrigger>
        <ToolIcon>
          <TerminalIcon />
        </ToolIcon>
        <ToolName>Read</ToolName>
        <ToolLabel>path</ToolLabel>
      </ToolTrigger>
      <ToolContent>
        <ToolSubtitle>Arguments</ToolSubtitle>
        <ToolArgument
          value={`"apps/www/src/components/ai/tool.tsx"`}
          state="complete"
        />
      </ToolContent>
    </Tool>
  </Surface>
);

export const LongNameAndLabelOverflow: Story = () => (
  <Surface>
    <Tool state="success">
      <ToolTrigger>
        <ToolIcon>
          <TerminalIcon />
        </ToolIcon>
        <ToolName>mcp__linear__list_issues_with_a_very_long_tool_name</ToolName>
        <ToolLabel>
          apps/www/src/components/chat/transcript-view/leaves/tool-view-props.ts
          with an extremely long descriptive label that must truncate
        </ToolLabel>
      </ToolTrigger>
    </Tool>
  </Surface>
);

export const LongOutputOverflow: Story = () => (
  <Surface>
    <Tool state="success" defaultOpen>
      <ToolTrigger>
        <ToolIcon>
          <TerminalIcon />
        </ToolIcon>
        <ToolName>Bash</ToolName>
        <ToolLabel>git log</ToolLabel>
      </ToolTrigger>
      <ToolContent>
        <ToolSubtitle>Output</ToolSubtitle>
        <ToolBlock>
          {Array.from(
            { length: 40 },
            (_, i) =>
              `${(9944000 + i).toString(16)} commit ${i}: refactor transcript store fold and registry leaf mapping for state ${i}`,
          ).join("\n")}
        </ToolBlock>
      </ToolContent>
    </Tool>
  </Surface>
);

export default {
  title: "ai/tool",
} satisfies StoryDefault;
