import type { Story, StoryDefault } from "@ladle/react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtIcon,
  ChainOfThoughtStep,
  ChainOfThoughtStepContent,
  ChainOfThoughtStepStatic,
  ChainOfThoughtStepTrigger,
} from "./chain-of-thought";
import { Loader } from "./loader";

const Spinner = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    className="size-3.5 animate-spin"
    aria-hidden
  >
    <path d="M21 12a9 9 0 1 1-6.2-8.5" />
  </svg>
);

const CheckIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-3.5"
    aria-hidden
  >
    <path d="m5 13 4 4 10-10" />
  </svg>
);

export const Collapsed: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <ChainOfThought>
        <ChainOfThoughtHeader>Worked through 3 steps</ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          <ChainOfThoughtStepStatic>
            <ChainOfThoughtIcon />
            Read <code>agent/orchestrator.ts</code>
          </ChainOfThoughtStepStatic>
          <ChainOfThoughtStepStatic>
            <ChainOfThoughtIcon />
            Ran <code>pnpm -C packages/sandbox test</code>
          </ChainOfThoughtStepStatic>
          <ChainOfThoughtStepStatic>
            <ChainOfThoughtIcon />
            Patched the resume branch
          </ChainOfThoughtStepStatic>
        </ChainOfThoughtContent>
      </ChainOfThought>
    </div>
  );
};

export const ExpandedStaticSteps: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <ChainOfThought defaultOpen>
        <ChainOfThoughtHeader>Worked through 3 steps</ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          <ChainOfThoughtStepStatic>
            <ChainOfThoughtIcon />
            Read <code>agent/orchestrator.ts</code> to locate the resume path
          </ChainOfThoughtStepStatic>
          <ChainOfThoughtStepStatic>
            <ChainOfThoughtIcon />
            Ran <code>pnpm -C packages/sandbox test</code> to reproduce the
            hibernation failure
          </ChainOfThoughtStepStatic>
          <ChainOfThoughtStepStatic>
            <ChainOfThoughtIcon />
            Changed the null handle to route into resume instead of a hard error
          </ChainOfThoughtStepStatic>
        </ChainOfThoughtContent>
      </ChainOfThought>
    </div>
  );
};

export const ExpandedCollapsibleSteps: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <ChainOfThought defaultOpen>
        <ChainOfThoughtHeader>
          Investigated the test failure
        </ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          <ChainOfThoughtStep defaultOpen>
            <ChainOfThoughtStepTrigger>
              <ChainOfThoughtIcon />
              Reproduce the failure
            </ChainOfThoughtStepTrigger>
            <ChainOfThoughtStepContent>
              Running the sandbox suite surfaced <code>resolveSandbox()</code>{" "}
              returning <code>undefined</code> once the E2B session hibernated.
            </ChainOfThoughtStepContent>
          </ChainOfThoughtStep>
          <ChainOfThoughtStep>
            <ChainOfThoughtStepTrigger>
              <ChainOfThoughtIcon />
              Trace the caller
            </ChainOfThoughtStepTrigger>
            <ChainOfThoughtStepContent>
              The orchestrator assumed a live handle and never branched into the
              recoverable resume path.
            </ChainOfThoughtStepContent>
          </ChainOfThoughtStep>
          <ChainOfThoughtStep>
            <ChainOfThoughtStepTrigger>
              <ChainOfThoughtIcon />
              Apply the fix
            </ChainOfThoughtStepTrigger>
            <ChainOfThoughtStepContent>
              Treat a null handle as "needs resume" so a hibernated sandbox no
              longer surfaces as a hard failure.
            </ChainOfThoughtStepContent>
          </ChainOfThoughtStep>
        </ChainOfThoughtContent>
      </ChainOfThought>
    </div>
  );
};

export const CustomStepIcons: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <ChainOfThought defaultOpen>
        <ChainOfThoughtHeader>Planned the change</ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          <ChainOfThoughtStepStatic>
            <ChainOfThoughtIcon>1</ChainOfThoughtIcon>
            Search for existing usages
          </ChainOfThoughtStepStatic>
          <ChainOfThoughtStepStatic>
            <ChainOfThoughtIcon>2</ChainOfThoughtIcon>
            Update the shared type
          </ChainOfThoughtStepStatic>
          <ChainOfThoughtStepStatic>
            <ChainOfThoughtIcon>3</ChainOfThoughtIcon>
            Re-run the type check
          </ChainOfThoughtStepStatic>
        </ChainOfThoughtContent>
      </ChainOfThought>
    </div>
  );
};

export const InProgressStep: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <ChainOfThought defaultOpen>
        <ChainOfThoughtHeader>
          <Loader variant="shimmer">Working</Loader>
        </ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          <ChainOfThoughtStepStatic>
            <ChainOfThoughtIcon className="text-success">
              <CheckIcon />
            </ChainOfThoughtIcon>
            Read <code>agent/orchestrator.ts</code>
          </ChainOfThoughtStepStatic>
          <ChainOfThoughtStepStatic>
            <ChainOfThoughtIcon className="text-success">
              <CheckIcon />
            </ChainOfThoughtIcon>
            Ran <code>pnpm -C packages/sandbox test</code>
          </ChainOfThoughtStepStatic>
          <ChainOfThoughtStepStatic>
            <ChainOfThoughtIcon className="text-primary">
              <Spinner />
            </ChainOfThoughtIcon>
            <Loader variant="shimmer">Patching the resume branch</Loader>
          </ChainOfThoughtStepStatic>
        </ChainOfThoughtContent>
      </ChainOfThought>
    </div>
  );
};

export const MixedStaticAndCollapsibleSteps: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <ChainOfThought defaultOpen>
        <ChainOfThoughtHeader>
          Investigated the test failure
        </ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          <ChainOfThoughtStepStatic>
            <ChainOfThoughtIcon className="text-success">
              <CheckIcon />
            </ChainOfThoughtIcon>
            Read <code>agent/orchestrator.ts</code> to locate the resume path
          </ChainOfThoughtStepStatic>
          <ChainOfThoughtStep defaultOpen>
            <ChainOfThoughtStepTrigger>
              <ChainOfThoughtIcon />
              Reproduce the failure
            </ChainOfThoughtStepTrigger>
            <ChainOfThoughtStepContent>
              Running the sandbox suite surfaced <code>resolveSandbox()</code>{" "}
              returning <code>undefined</code> once the E2B session hibernated.
            </ChainOfThoughtStepContent>
          </ChainOfThoughtStep>
          <ChainOfThoughtStep>
            <ChainOfThoughtStepTrigger>
              <ChainOfThoughtIcon />
              Trace the caller
            </ChainOfThoughtStepTrigger>
            <ChainOfThoughtStepContent>
              The orchestrator assumed a live handle and never branched into the
              recoverable resume path.
            </ChainOfThoughtStepContent>
          </ChainOfThoughtStep>
          <ChainOfThoughtStepStatic>
            <ChainOfThoughtIcon className="text-primary">
              <Spinner />
            </ChainOfThoughtIcon>
            <Loader variant="shimmer">Applying the fix</Loader>
          </ChainOfThoughtStepStatic>
        </ChainOfThoughtContent>
      </ChainOfThought>
    </div>
  );
};

export default {
  title: "ai/chain-of-thought",
} satisfies StoryDefault;
