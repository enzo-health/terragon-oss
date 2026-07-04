import type { Story, StoryDefault } from "@ladle/react";
import {
  Sandbox,
  SandboxAction,
  SandboxContent,
  SandboxHeader,
  SandboxPanel,
  SandboxTab,
  SandboxTabs,
  SandboxTabsList,
  SandboxTitle,
  SandboxTrigger,
} from "./sandbox";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const TerminalIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="m4 17 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 19h8" strokeLinecap="round" />
  </svg>
);

const FilesIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path
      d="M4 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"
      strokeLinejoin="round"
    />
  </svg>
);

const StopIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <rect x="7" y="7" width="10" height="10" rx="1" />
  </svg>
);

const TERMINAL_OUTPUT = `$ pnpm -C apps/www test src/components/chat
 ✓ transcript-store fold (12)
 ✓ registry exhaustiveness (4)
 Test Files  2 passed (2)
      Tests  16 passed (16)`;

export const Running: Story = () => (
  <Surface>
    <Sandbox state="running" defaultOpen>
      <SandboxHeader>
        <SandboxTrigger>
          <SandboxTitle>sandbox-e2b-9f3a · running</SandboxTitle>
        </SandboxTrigger>
        <SandboxAction>
          <button type="button">
            <StopIcon />
          </button>
        </SandboxAction>
      </SandboxHeader>
      <SandboxContent>
        <SandboxTabs defaultValue="terminal">
          <SandboxTabsList>
            <SandboxTab value="terminal">
              <TerminalIcon />
              Terminal
            </SandboxTab>
            <SandboxTab value="files">
              <FilesIcon />
              Files
            </SandboxTab>
          </SandboxTabsList>
          <SandboxPanel value="terminal">
            <pre>{`$ pnpm install\nProgress: resolved 1284, reused 1284, downloaded 0…`}</pre>
          </SandboxPanel>
          <SandboxPanel value="files">
            <pre>{`apps/www/\npackages/shared/\npackages/daemon/`}</pre>
          </SandboxPanel>
        </SandboxTabs>
      </SandboxContent>
    </Sandbox>
  </Surface>
);

export const Success: Story = () => (
  <Surface>
    <Sandbox state="success" defaultOpen>
      <SandboxHeader>
        <SandboxTrigger>
          <SandboxTitle>sandbox-e2b-9f3a · done</SandboxTitle>
        </SandboxTrigger>
        <SandboxAction>
          <button type="button">Reopen</button>
        </SandboxAction>
      </SandboxHeader>
      <SandboxContent>
        <SandboxTabs defaultValue="terminal">
          <SandboxTabsList>
            <SandboxTab value="terminal">
              <TerminalIcon />
              Terminal
            </SandboxTab>
          </SandboxTabsList>
          <SandboxPanel value="terminal">
            <pre>{TERMINAL_OUTPUT}</pre>
          </SandboxPanel>
        </SandboxTabs>
      </SandboxContent>
    </Sandbox>
  </Surface>
);

export const SuccessCollapsed: Story = () => (
  <Surface>
    <Sandbox state="success">
      <SandboxHeader>
        <SandboxTrigger>
          <SandboxTitle>sandbox-e2b-9f3a · done</SandboxTitle>
        </SandboxTrigger>
        <SandboxAction>
          <button type="button">Logs</button>
        </SandboxAction>
      </SandboxHeader>
      <SandboxContent>
        <SandboxTabs defaultValue="terminal">
          <SandboxTabsList>
            <SandboxTab value="terminal">
              <TerminalIcon />
              Terminal
            </SandboxTab>
          </SandboxTabsList>
          <SandboxPanel value="terminal">
            <pre>{TERMINAL_OUTPUT}</pre>
          </SandboxPanel>
        </SandboxTabs>
      </SandboxContent>
    </Sandbox>
  </Surface>
);

export const Errored: Story = () => (
  <Surface>
    <Sandbox state="error" defaultOpen>
      <SandboxHeader>
        <SandboxTrigger>
          <SandboxTitle>sandbox-e2b-9f3a · failed</SandboxTitle>
        </SandboxTrigger>
        <SandboxAction>
          <button type="button">Retry</button>
        </SandboxAction>
      </SandboxHeader>
      <SandboxContent>
        <SandboxTabs defaultValue="terminal">
          <SandboxTabsList>
            <SandboxTab value="terminal">
              <TerminalIcon />
              Terminal
            </SandboxTab>
          </SandboxTabsList>
          <SandboxPanel value="terminal">
            <pre className="text-destructive">{`$ pnpm build\nerror TS2345: Argument of type 'string' is not assignable to parameter of type 'TranscriptItem'.\n  at registry.tsx:42:18\nELIFECYCLE  Command failed with exit code 2.`}</pre>
          </SandboxPanel>
        </SandboxTabs>
      </SandboxContent>
    </Sandbox>
  </Surface>
);

export const TruncatedTitle: Story = () => (
  <Surface>
    <Sandbox state="running">
      <SandboxHeader>
        <SandboxTrigger>
          <SandboxTitle>
            sandbox-e2b-9f3a-a-very-long-identifier-that-should-truncate-inside-the-header-row
          </SandboxTitle>
        </SandboxTrigger>
        <SandboxAction>
          <button type="button">
            <StopIcon />
          </button>
        </SandboxAction>
      </SandboxHeader>
      <SandboxContent>
        <SandboxTabs defaultValue="terminal">
          <SandboxTabsList>
            <SandboxTab value="terminal">
              <TerminalIcon />
              Terminal
            </SandboxTab>
          </SandboxTabsList>
          <SandboxPanel value="terminal">
            <pre>{`$ tail -f build.log`}</pre>
          </SandboxPanel>
        </SandboxTabs>
      </SandboxContent>
    </Sandbox>
  </Surface>
);

export default {
  title: "ai/sandbox",
} satisfies StoryDefault;
