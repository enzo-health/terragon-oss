import type { Story, StoryDefault } from "@ladle/react";
import { Loader } from "./loader";

function Surface({ children }: { children: React.ReactNode }) {
  return <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>;
}

export const Default: Story = () => (
  <Surface>
    <Loader>Loading</Loader>
  </Surface>
);

export const PulseVariant: Story = () => (
  <Surface>
    <Loader variant="pulse">Assistant is thinking</Loader>
  </Surface>
);

export const ShimmerVariant: Story = () => (
  <Surface>
    <Loader variant="shimmer">Running `pnpm -C apps/www test`</Loader>
  </Surface>
);

export const WithDots: Story = () => (
  <Surface>
    <Loader variant="pulse" dots>
      Cloning repository
    </Loader>
  </Surface>
);

export const ShimmerWithDots: Story = () => (
  <Surface>
    <Loader variant="shimmer" dots>
      Installing dependencies
    </Loader>
  </Surface>
);

export const FastDuration: Story = () => (
  <Surface>
    <Loader variant="shimmer" duration={0.8}>
      Streaming tokens
    </Loader>
  </Surface>
);

export const SlowDuration: Story = () => (
  <Surface>
    <Loader variant="pulse" duration={3}>
      Waiting on sandbox
    </Loader>
  </Surface>
);

export const NarrowSpread: Story = () => (
  <Surface>
    <Loader variant="shimmer" spread={15}>
      Applying diff to `apps/www/src/agent/`
    </Loader>
  </Surface>
);

export const WideSpread: Story = () => (
  <Surface>
    <Loader variant="shimmer" spread={80}>
      Applying diff to `apps/www/src/agent/`
    </Loader>
  </Surface>
);

export const LongLabel: Story = () => (
  <Surface>
    <Loader variant="shimmer" dots>
      Booting environment, cloning repository, installing the agent, and running
      the setup script
    </Loader>
  </Surface>
);

export const PipelineStates: Story = () => (
  <Surface>
    <div className="flex flex-col gap-3">
      <Loader variant="shimmer" dots>
        Booting environment
      </Loader>
      <Loader variant="shimmer" dots>
        Cloning `terragon-labs/terragon`
      </Loader>
      <Loader variant="shimmer" dots>
        Installing agent
      </Loader>
      <Loader variant="pulse" dots>
        Assistant is working
      </Loader>
    </div>
  </Surface>
);

export default {
  title: "ai/loader",
} satisfies StoryDefault;
