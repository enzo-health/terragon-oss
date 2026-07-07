import type { Story, StoryDefault } from "@ladle/react";
import { Loader } from "./loader";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./reasoning";

const SHORT_REASONING =
  "The user wants to rename the handler, so I need to update the export and its single call site.";

const LONG_REASONING = `The test failure points at \`resolveSandbox()\` returning \`undefined\` when the E2B session has already hibernated. I should:

1. Reproduce by calling \`pnpm -C packages/sandbox test\` against the hibernation case.
2. Check whether \`getSession(id)\` throws or returns null on a stale id.
3. If it returns null, the caller in \`agent/orchestrator.ts\` must branch into the resume path instead of assuming a live handle.

The safest fix is to treat null as "needs resume" rather than "not found", because a not-found error currently surfaces to the user as a hard failure even though the sandbox is recoverable.`;

export const Collapsed: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Reasoning>
        <ReasoningTrigger>Thought for 3 seconds</ReasoningTrigger>
        <ReasoningContent>{SHORT_REASONING}</ReasoningContent>
      </Reasoning>
    </div>
  );
};

export const Expanded: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Reasoning defaultOpen>
        <ReasoningTrigger>Thought for 3 seconds</ReasoningTrigger>
        <ReasoningContent>{SHORT_REASONING}</ReasoningContent>
      </Reasoning>
    </div>
  );
};

export const ExpandedLongContent: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Reasoning defaultOpen>
        <ReasoningTrigger>Thought for 18 seconds</ReasoningTrigger>
        <ReasoningContent>
          <div className="whitespace-pre-wrap">{LONG_REASONING}</div>
        </ReasoningContent>
      </Reasoning>
    </div>
  );
};

export const ForcedOpen: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Reasoning open>
        <ReasoningTrigger>Reasoning</ReasoningTrigger>
        <ReasoningContent>{SHORT_REASONING}</ReasoningContent>
      </Reasoning>
    </div>
  );
};

export const StreamingLive: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Reasoning open>
        <ReasoningTrigger>
          <Loader variant="shimmer">Thinking</Loader>
        </ReasoningTrigger>
        <ReasoningContent>
          <div className="whitespace-pre-wrap">
            {`The test failure points at \`resolveSandbox()\` returning \`undefined\` once the session hibernated. First I should reproduce it, then check whether \`getSession(id)\` throws or returns null on a stale id, and`}
            <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-current align-baseline" />
          </div>
        </ReasoningContent>
      </Reasoning>
    </div>
  );
};

export default {
  title: "ai/reasoning",
} satisfies StoryDefault;
