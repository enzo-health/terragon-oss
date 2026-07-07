import type { Story, StoryDefault } from "@ladle/react";
import {
  AgentRun,
  AgentRunContent,
  AgentRunHeader,
  AgentRunMeta,
  AgentRunStep,
  AgentRunText,
  AgentRunTitle,
} from "./agent-run";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const steps = (
  <>
    <AgentRunStep>
      <AgentRunText>
        Read <code>apps/www/src/components/ai/agent-run.tsx</code>
      </AgentRunText>
    </AgentRunStep>
    <AgentRunStep>
      <AgentRunText>
        Edited <code>registry.tsx</code> to map the new leaf.
      </AgentRunText>
    </AgentRunStep>
    <AgentRunStep>
      <AgentRunText>Ran the integration harness replay.</AgentRunText>
    </AgentRunStep>
  </>
);

export const RunningCollapsed: Story = () => (
  <Surface>
    <AgentRun state="running">
      <AgentRunHeader>
        <AgentRunTitle>Investigate flaky resume stream</AgentRunTitle>
        <AgentRunMeta>running</AgentRunMeta>
      </AgentRunHeader>
      <AgentRunContent>{steps}</AgentRunContent>
    </AgentRun>
  </Surface>
);

export const RunningExpanded: Story = () => (
  <Surface>
    <AgentRun state="running" defaultOpen>
      <AgentRunHeader>
        <AgentRunTitle>Investigate flaky resume stream</AgentRunTitle>
        <AgentRunMeta>3 steps</AgentRunMeta>
      </AgentRunHeader>
      <AgentRunContent>{steps}</AgentRunContent>
    </AgentRun>
  </Surface>
);

export const Completed: Story = () => (
  <Surface>
    <AgentRun state="completed" defaultOpen>
      <AgentRunHeader>
        <AgentRunTitle>Add Ladle stories for nauval leaves</AgentRunTitle>
        <AgentRunMeta>completed · 42s</AgentRunMeta>
      </AgentRunHeader>
      <AgentRunContent>{steps}</AgentRunContent>
    </AgentRun>
  </Surface>
);

export const Failed: Story = () => (
  <Surface>
    <AgentRun state="failed" defaultOpen>
      <AgentRunHeader>
        <AgentRunTitle>Push checkpoint to origin</AgentRunTitle>
        <AgentRunMeta>failed</AgentRunMeta>
      </AgentRunHeader>
      <AgentRunContent>
        <AgentRunStep>
          <AgentRunText>
            Ran <code>git push origin terragon/fca1cf</code>
          </AgentRunText>
        </AgentRunStep>
        <AgentRunStep>
          <AgentRunText>
            Rejected: non-fast-forward. The remote counterpart is ahead.
          </AgentRunText>
        </AgentRunStep>
      </AgentRunContent>
    </AgentRun>
  </Surface>
);

export const Stopped: Story = () => (
  <Surface>
    <AgentRun state="stopped" defaultOpen>
      <AgentRunHeader>
        <AgentRunTitle>Long refactor sweep</AgentRunTitle>
        <AgentRunMeta>stopped by user</AgentRunMeta>
      </AgentRunHeader>
      <AgentRunContent>{steps}</AgentRunContent>
    </AgentRun>
  </Surface>
);

export const StepsWithoutText: Story = () => (
  <Surface>
    <AgentRun state="running" defaultOpen>
      <AgentRunHeader>
        <AgentRunTitle>Mixed steps spacing</AgentRunTitle>
        <AgentRunMeta>running</AgentRunMeta>
      </AgentRunHeader>
      <AgentRunContent>
        <AgentRunStep>
          <span className="text-muted-foreground">Bash · pnpm install</span>
        </AgentRunStep>
        <AgentRunStep>
          <AgentRunText>Installed 1284 packages in 18s.</AgentRunText>
        </AgentRunStep>
        <AgentRunStep>
          <span className="text-muted-foreground">Read · package.json</span>
        </AgentRunStep>
      </AgentRunContent>
    </AgentRun>
  </Surface>
);

export const LongTitleOverflow: Story = () => (
  <Surface>
    <AgentRun state="running" defaultOpen>
      <AgentRunHeader>
        <AgentRunTitle>
          Stabilize ACP session continuity across turns and reconcile the
          server-authoritative run liveness resume policy end to end
        </AgentRunTitle>
        <AgentRunMeta>running</AgentRunMeta>
      </AgentRunHeader>
      <AgentRunContent>{steps}</AgentRunContent>
    </AgentRun>
  </Surface>
);

export default {
  title: "ai/agent-run",
} satisfies StoryDefault;
