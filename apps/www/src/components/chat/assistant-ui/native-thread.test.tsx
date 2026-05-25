/* @vitest-environment jsdom */

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { ThreadInfoFull, UIPart } from "@terragon/shared";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MessagePartRenderProps } from "../chat-message.types";
import {
  TerragonMessageRenderProvider,
  type TerragonMessageRenderContext,
  TerragonThreadProvider,
  type TerragonThreadContext,
} from "./thread-context";

const messagePartSpy = vi.hoisted(() => vi.fn());

vi.mock("../message-part", async () => {
  const { createElement: h } = await import("react");
  return {
    MessagePart: ({ part }: { part: UIPart }) => {
      messagePartSpy(part);
      return h("div", { "data-testid": "message-part" }, part.type);
    },
  };
});

import { NativeThread } from "./native-thread";

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

const baseMessagePartProps: MessagePartRenderProps = {
  githubRepoFullName: "acme/app",
  branchName: "feature/native",
  baseBranchName: "main",
  hasCheckpoint: false,
  toolProps: {
    threadId: "thread-1",
    threadChatId: "chat-1",
    messagesRef: { current: [] },
    isReadOnly: false,
    childThreads: [],
    githubRepoFullName: "acme/app",
    repoBaseBranchName: "main",
    branchName: "feature/native",
  },
};

const threadCtx: TerragonThreadContext = {
  thread: null as ThreadInfoFull | null,
  latestGitDiffTimestamp: null,
  isAgentWorking: false,
  artifactDescriptors: [],
  onOpenArtifact: vi.fn(),
  planOccurrences: new Map(),
  redoDialogData: undefined,
  forkDialogData: undefined,
  toolProps: baseMessagePartProps.toolProps,
  messagePartProps: baseMessagePartProps,
};

const renderCtx: TerragonMessageRenderContext = {
  isAgentWorking: false,
  artifactDescriptors: [],
  onOpenArtifact: vi.fn(),
  planOccurrences: new Map(),
  redoDialogData: undefined,
  forkDialogData: undefined,
  messagePartProps: baseMessagePartProps,
};

const SEED_MESSAGES: ThreadMessageLike[] = [
  { role: "user", content: "show me the files" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Here are the files." },
      {
        type: "tool-call",
        toolCallId: "t1",
        toolName: "Bash",
        argsText: '{"command":"ls"}',
        result: "file.txt",
      },
      {
        type: "data",
        name: "terragon.terminal",
        data: {
          messageId: "m1",
          partIndex: 2,
          name: "terragon.terminal",
          data: {
            type: "terminal",
            sandboxId: "sandbox-1",
            terminalId: "term-1",
            chunks: [{ streamSeq: 0, kind: "stdout", text: "running tests" }],
          },
        },
      },
    ],
  },
];

function Harness() {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: SEED_MESSAGES,
    isRunning: false,
    convertMessage: (message) => message,
    onNew: async () => {},
  });
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(
      TerragonThreadProvider,
      { value: threadCtx },
      createElement(
        TerragonMessageRenderProvider,
        { value: renderCtx },
        createElement(NativeThread, { agent: "codex" }),
      ),
    ),
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  messagePartSpy.mockClear();
});

describe("NativeThread", () => {
  it("renders every runtime part type losslessly through MessagePart", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(Harness));
    });

    const renderedTypes = messagePartSpy.mock.calls.map(
      (call) => (call[0] as UIPart).type,
    );
    // User text, assistant text, the tool call, and the rich terminal data
    // part all reach MessagePart — no part type is silently dropped.
    expect(renderedTypes).toContain("text");
    expect(renderedTypes).toContain("tool");
    expect(renderedTypes).toContain("terminal");
  });
});
