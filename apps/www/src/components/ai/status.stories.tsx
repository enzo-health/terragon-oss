import type { Story, StoryDefault } from "@ladle/react";
import { Status } from "./status";

function Surface({ children }: { children: React.ReactNode }) {
  return <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>;
}

export const Neutral: Story = () => (
  <Surface>
    <Status state="neutral">Idle</Status>
  </Surface>
);

export const Pending: Story = () => (
  <Surface>
    <Status state="pending">Queued</Status>
  </Surface>
);

export const Inflight: Story = () => (
  <Surface>
    <Status state="inflight">Running `git push`</Status>
  </Surface>
);

export const Warning: Story = () => (
  <Surface>
    <Status state="warning">Rate limit approaching</Status>
  </Surface>
);

export const Active: Story = () => (
  <Surface>
    <Status state="active">Sandbox ready</Status>
  </Surface>
);

export const ErrorState: Story = () => (
  <Surface>
    <Status state="error">Push rejected</Status>
  </Surface>
);

export const InflightPulse: Story = () => (
  <Surface>
    <Status state="inflight" pulse>
      Streaming response
    </Status>
  </Surface>
);

export const ActivePulse: Story = () => (
  <Surface>
    <Status state="active" pulse>
      Agent connected
    </Status>
  </Surface>
);

export const SmallSize: Story = () => (
  <Surface>
    <div className="flex flex-wrap items-center gap-2">
      <Status state="neutral" size="sm">
        Idle
      </Status>
      <Status state="inflight" size="sm" pulse>
        Working
      </Status>
      <Status state="warning" size="sm">
        3 retries
      </Status>
      <Status state="error" size="sm">
        Failed
      </Status>
    </div>
  </Surface>
);

export const AsButton: Story = () => (
  <Surface>
    <Status
      state="warning"
      render={<button type="button" onClick={() => console.log("clicked")} />}
    >
      12k / 200k tokens
    </Status>
  </Surface>
);

export const DotOnly: Story = () => (
  <Surface>
    <div className="flex flex-wrap items-center gap-2">
      <Status state="neutral" aria-label="Idle" />
      <Status state="pending" aria-label="Queued" />
      <Status state="inflight" pulse aria-label="Running" />
      <Status state="warning" aria-label="Warning" />
      <Status state="active" pulse aria-label="Ready" />
      <Status state="error" aria-label="Error" />
    </div>
  </Surface>
);

export const AllStates: Story = () => (
  <Surface>
    <div className="flex flex-col items-start gap-2">
      <Status state="neutral">Neutral — idle</Status>
      <Status state="pending">Pending — queued</Status>
      <Status state="inflight" pulse>
        Inflight — running `pnpm build`
      </Status>
      <Status state="warning">Warning — rate limit approaching</Status>
      <Status state="active" pulse>
        Active — sandbox ready
      </Status>
      <Status state="error">Error — sandbox creation failed</Status>
    </div>
  </Surface>
);

export const LongLabelOverflow: Story = () => (
  <Surface>
    <Status state="error">
      Error — failed to push some refs to
      `github.com:terragon-labs/terragon.git`, tip of your current branch is
      behind its remote counterpart
    </Status>
  </Surface>
);

export default {
  title: "ai/status",
} satisfies StoryDefault;
