/* @vitest-environment jsdom */

/**
 * Performance-behavior test: proves that during AG-UI text streaming, only
 * the row for the message currently being streamed re-renders. Historical
 * rows must NOT re-render when the `TerragonThreadContext` reference is
 * stable.
 *
 * Measurement: we spy on `useTerragonThread`. Every row calls it at the top
 * of its function body, so the spy's call count equals the number of row
 * bodies that ran. `React.memo` short-circuits the body when props are
 * referentially equal, so bailed rows do not increment the counter while
 * rendered rows do (exactly once per render). The spy preserves the real
 * implementation, so the rest of the tree renders end-to-end.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadInfoFull, UIMessage } from "@terragon/shared";

// The chat-message-toolbar chain transitively imports `transcribe-audio`,
// which constructs a real `OpenAI` client at module load. Under jsdom the
// SDK detects `window` and throws. We never exercise transcription, so stub.
vi.mock("@/server-actions/transcribe-audio", () => ({
  transcribeAudio: vi.fn(),
}));

import type { MessagePartRenderProps } from "../chat-message.types";
import * as threadContextModule from "./thread-context";
import {
  TerragonThreadProvider,
  type TerragonThreadContext,
} from "./thread-context";
import { TerragonUserMessage } from "./user-message";
import { TerragonAssistantMessage } from "./assistant-message";

const msgU1: UIMessage = {
  id: "msg-u1",
  role: "user",
  parts: [{ type: "text", text: "hello" }],
};

const msgA1: UIMessage = {
  id: "msg-a1",
  role: "agent",
  agent: "claudeCode",
  parts: [
    { type: "text", text: "historical first" },
    { type: "text", text: "historical second" },
  ],
};

function makeStreamingAgent(text: string): UIMessage {
  return {
    id: "msg-a2",
    role: "agent",
    agent: "claudeCode",
    parts: [{ type: "text", text }],
  };
}

const baseMessagePartProps: MessagePartRenderProps = {
  githubRepoFullName: "acme/app",
  branchName: "feature/streaming",
  baseBranchName: "main",
  hasCheckpoint: false,
  toolProps: {
    threadId: "thread-1",
    threadChatId: "chat-1",
    messages: [],
    isReadOnly: false,
    childThreads: [],
    githubRepoFullName: "acme/app",
    repoBaseBranchName: "main",
    branchName: "feature/streaming",
  },
};

function makeCtx(
  overrides: Partial<TerragonThreadContext> = {},
): TerragonThreadContext {
  return {
    // Rendering user/agent rows never dereferences `ctx.thread` (it's only
    // read for the system-message branch). `null` is a legal value of
    // `TerragonThreadContext["thread"]`.
    thread: null as ThreadInfoFull | null,
    latestGitDiffTimestamp: null,
    isAgentWorking: true,
    artifactDescriptors: [],
    onOpenArtifact: vi.fn(),
    planOccurrences: new Map(),
    redoDialogData: undefined,
    forkDialogData: undefined,
    toolProps: baseMessagePartProps.toolProps,
    messagePartProps: baseMessagePartProps,
    ...overrides,
  };
}

function TestThread({
  messages,
  ctx,
}: {
  messages: UIMessage[];
  ctx: TerragonThreadContext;
}) {
  const lastIndex = messages.length - 1;
  return createElement(
    TerragonThreadProvider,
    { value: ctx },
    createElement(
      "div",
      null,
      messages.map((message, index) => {
        const isLatestMessage = index === lastIndex;
        if (message.role === "user") {
          return createElement(TerragonUserMessage, {
            key: message.id,
            message,
            messageIndex: index,
            isLatestMessage,
            isFirstUserMessage: index === 0,
          });
        }
        if (message.role === "agent") {
          return createElement(TerragonAssistantMessage, {
            key: message.id,
            message,
            messageIndex: index,
            isLatestMessage,
            isLatestAgentMessage: index === lastIndex,
          });
        }
        return null;
      }),
    ),
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
}

function update(element: React.ReactElement) {
  act(() => {
    root!.render(element);
  });
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  vi.restoreAllMocks();
});

/**
 * Every row calls `useTerragonThread` once per body execution, so the spy's
 * call delta across renders is the row-body-execution count.
 */
function spyOnThreadHook() {
  return vi.spyOn(threadContextModule, "useTerragonThread");
}

describe("chat row memoization during streaming", () => {
  it("historical rows do not rerender on streaming delta when ctx stays stable", () => {
    const spy = spyOnThreadHook();
    const ctx = makeCtx();
    const msgA2Initial = makeStreamingAgent("streaming");

    mount(
      createElement(TestThread, {
        messages: [msgU1, msgA1, msgA2Initial],
        ctx,
      }),
    );

    // Initial mount runs each of the 3 rows' bodies exactly once.
    const afterMount = spy.mock.calls.length;
    expect(afterMount).toBe(3);

    // Streaming delta: only msg-a2 gets a new reference; ctx is unchanged.
    const msgA2Next = makeStreamingAgent("streaming world");
    update(
      createElement(TestThread, { messages: [msgU1, msgA1, msgA2Next], ctx }),
    );

    // Only the streaming row re-ran its body. msg-u1 and msg-a1 stayed
    // bailed-out thanks to `React.memo` + stable ctx reference.
    expect(spy.mock.calls.length - afterMount).toBe(1);
  });

  it("all rows rerender when ctx reference changes", () => {
    // Proves the memo path is truly gated on ctx stability. If a careless
    // refactor drops `useMemo` around the ctx object, this test fails.
    const spy = spyOnThreadHook();
    const msgA2 = makeStreamingAgent("streaming");
    const messages = [msgU1, msgA1, msgA2];

    mount(createElement(TestThread, { messages, ctx: makeCtx() }));
    const afterMount = spy.mock.calls.length;
    expect(afterMount).toBe(3);

    // Same messages (identical refs), brand-new ctx with same content.
    update(createElement(TestThread, { messages, ctx: makeCtx() }));

    // New context value → every consumer's body re-runs.
    expect(spy.mock.calls.length - afterMount).toBe(3);
  });

  it("multiple text deltas accumulate proportionally for streaming row only", () => {
    const spy = spyOnThreadHook();
    const ctx = makeCtx();

    mount(
      createElement(TestThread, {
        messages: [msgU1, msgA1, makeStreamingAgent("s")],
        ctx,
      }),
    );
    const afterMount = spy.mock.calls.length;
    expect(afterMount).toBe(3);

    const frames = ["st", "str", "stre", "strea", "stream"];
    for (const text of frames) {
      update(
        createElement(TestThread, {
          messages: [msgU1, msgA1, makeStreamingAgent(text)],
          ctx,
        }),
      );
    }

    // One new body execution per delta — msg-a2 only.
    expect(spy.mock.calls.length - afterMount).toBe(frames.length);
  });
});
