import type { Story, StoryDefault } from "@ladle/react";
import {
  Exception,
  ExceptionAction,
  ExceptionContent,
  ExceptionFrame,
  ExceptionFrameFunction,
  ExceptionFrameLocation,
  ExceptionFrames,
  ExceptionHeader,
  ExceptionMessage,
  ExceptionSource,
  ExceptionSourceContent,
  ExceptionSourceHeader,
  ExceptionTrigger,
  ExceptionType,
} from "./exception";

const surface = (children: React.ReactNode) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const Frames = () => (
  <ExceptionFrames>
    <ExceptionFrame active>
      <ExceptionFrameFunction>readThread</ExceptionFrameFunction>
      <ExceptionFrameLocation>
        apps/www/src/server/threads.ts:142:18
      </ExceptionFrameLocation>
    </ExceptionFrame>
    <ExceptionFrame>
      <ExceptionFrameFunction>resolveResumePolicy</ExceptionFrameFunction>
      <ExceptionFrameLocation>
        apps/www/src/server/resume.ts:87:9
      </ExceptionFrameLocation>
    </ExceptionFrame>
    <ExceptionFrame internal>
      <ExceptionFrameFunction>processTicksAndRejections</ExceptionFrameFunction>
      <ExceptionFrameLocation>
        node:internal/process/task_queues:95:5
      </ExceptionFrameLocation>
    </ExceptionFrame>
  </ExceptionFrames>
);

export const Collapsed: Story = () =>
  surface(
    <Exception>
      <ExceptionHeader>
        <ExceptionType>TypeError</ExceptionType>
        <ExceptionMessage>
          Cannot read properties of undefined (reading &apos;sandboxId&apos;)
        </ExceptionMessage>
        <ExceptionAction>
          <ExceptionTrigger>Stack</ExceptionTrigger>
        </ExceptionAction>
      </ExceptionHeader>
      <ExceptionContent>
        <Frames />
      </ExceptionContent>
    </Exception>,
  );

export const Expanded: Story = () =>
  surface(
    <Exception defaultOpen>
      <ExceptionHeader>
        <ExceptionType>TypeError</ExceptionType>
        <ExceptionMessage>
          Cannot read properties of undefined (reading &apos;sandboxId&apos;)
        </ExceptionMessage>
        <ExceptionAction>
          <ExceptionTrigger>Stack</ExceptionTrigger>
        </ExceptionAction>
      </ExceptionHeader>
      <ExceptionContent>
        <Frames />
      </ExceptionContent>
    </Exception>,
  );

export const ExpandedWithSource: Story = () =>
  surface(
    <Exception defaultOpen>
      <ExceptionHeader>
        <ExceptionType>Error</ExceptionType>
        <ExceptionMessage>
          ECONNREFUSED: connect to daemon at 127.0.0.1:8787 failed
        </ExceptionMessage>
        <ExceptionAction>
          <ExceptionTrigger>Stack</ExceptionTrigger>
        </ExceptionAction>
      </ExceptionHeader>
      <ExceptionContent>
        <Frames />
      </ExceptionContent>
      <ExceptionSource>
        <ExceptionSourceHeader>
          <span>apps/www/src/server/resume.ts</span>
          <span>87:9</span>
        </ExceptionSourceHeader>
        <ExceptionSourceContent>
          <pre>
            <code>
              <span>85 async function resolveResumePolicy(thread) {"{"}</span>
              <span>86 const sandbox = thread.sandbox;</span>
              <span data-active="true">
                87 return sandbox.sandboxId ?? throwMissing();
              </span>
              <span>88 {"}"}</span>
            </code>
          </pre>
        </ExceptionSourceContent>
      </ExceptionSource>
    </Exception>,
  );

export const LongMessageOverflow: Story = () =>
  surface(
    <Exception defaultOpen>
      <ExceptionHeader>
        <ExceptionType>AggregateError</ExceptionType>
        <ExceptionMessage>
          Failed to resume 3 sandboxes: e2b-9f3a1c (timeout after 30000ms),
          e2b-2b7d04 (image
          pull-failed:registry.internal/terragon/sandbox-image:latest not
          found), daytona-11ff9e (quota exceeded for organization
          org_5x9k2mQ8vJ). Retry with backoff or contact support.
        </ExceptionMessage>
        <ExceptionAction>
          <ExceptionTrigger>Stack</ExceptionTrigger>
        </ExceptionAction>
      </ExceptionHeader>
      <ExceptionContent>
        <ExceptionFrames>
          <ExceptionFrame active>
            <ExceptionFrameFunction>resumeAll</ExceptionFrameFunction>
            <ExceptionFrameLocation>
              apps/www/src/agent/sandbox/resume-all.ts:214:11-with-a-very-long-inlined-path-segment
            </ExceptionFrameLocation>
          </ExceptionFrame>
        </ExceptionFrames>
      </ExceptionContent>
    </Exception>,
  );

export default {
  title: "ai/exception",
} satisfies StoryDefault;
