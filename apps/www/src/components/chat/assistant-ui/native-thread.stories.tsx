import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { ReactNode } from "react";

import { NativeThread } from "./native-thread";

/**
 * Live-surface fixtures for the native transcript leaves (`NativeText`,
 * `NativeReasoning`, `NativeToolCall`, `NativeToolGroup`). These drive the real
 * `NativeThread` through an external-store runtime, so a re-skin that drops a
 * tool/reasoning state branch shows up here (and in the matching DOM-shape
 * assertions) rather than compiling clean against the dead-path stories.
 *
 * Tool state derivation lives in `NativeToolCall`:
 *   - running  → `result` undefined (or message status "running")
 *   - failed   → `isError: true`
 *   - done     → `result` present, no error
 */

function ThreadFixture({
  messages,
  isRunning = false,
}: {
  messages: ThreadMessageLike[];
  isRunning?: boolean;
}): ReactNode {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning,
    convertMessage: (message) => message,
    onNew: async () => {},
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="mx-auto max-w-chat px-4 py-6">
        <NativeThread />
      </div>
    </AssistantRuntimeProvider>
  );
}

export const StreamingText = () => (
  <ThreadFixture
    isRunning
    messages={[
      { role: "user", content: "Summarize the change." },
      {
        role: "assistant",
        status: { type: "running" },
        content: [
          {
            type: "text",
            text: "Streaming a partial response with **markdown** that is still",
          },
        ],
      },
    ]}
  />
);

export const ReasoningOpenStreaming = () => (
  <ThreadFixture
    isRunning
    messages={[
      { role: "user", content: "Think through the plan." },
      {
        role: "assistant",
        status: { type: "running" },
        content: [
          {
            type: "reasoning",
            text: "First I should inspect the directory, then decide which file to edit.",
          },
        ],
      },
    ]}
  />
);

export const ToolRunning = () => (
  <ThreadFixture
    isRunning
    messages={[
      { role: "user", content: "List the files." },
      {
        role: "assistant",
        status: { type: "running" },
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-running",
            toolName: "Bash",
            argsText: '{"command":"ls -la"}',
          },
        ],
      },
    ]}
  />
);

export const ToolFailed = () => (
  <ThreadFixture
    messages={[
      { role: "user", content: "Read the missing file." },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-failed",
            toolName: "Read",
            argsText: '{"file_path":"/tmp/missing.txt"}',
            result: "ENOENT: no such file or directory",
            isError: true,
          },
        ],
      },
    ]}
  />
);

export const ToolDone = () => (
  <ThreadFixture
    messages={[
      { role: "user", content: "Show the README." },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-done",
            toolName: "Read",
            argsText: '{"file_path":"README.md"}',
            result: "# Terragon\n\nAI-powered coding assistant.",
          },
        ],
      },
    ]}
  />
);

export const GroupedRunWithFailure = () => (
  <ThreadFixture
    messages={[
      { role: "user", content: "Run the build steps." },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "grp-1",
            toolName: "Bash",
            argsText: '{"command":"pnpm install"}',
            result: "Lockfile is up to date.",
          },
          {
            type: "tool-call",
            toolCallId: "grp-2",
            toolName: "Bash",
            argsText: '{"command":"pnpm build"}',
            result: "error: build failed",
            isError: true,
          },
          {
            type: "tool-call",
            toolCallId: "grp-3",
            toolName: "Read",
            argsText: '{"file_path":"dist/index.js"}',
            result: "// bundled output",
          },
        ],
      },
    ]}
  />
);
