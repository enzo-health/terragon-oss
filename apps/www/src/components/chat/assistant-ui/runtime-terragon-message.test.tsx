/* @vitest-environment jsdom */

import type { ThreadInfoFull, UIMessage, UIPart } from "@terragon/shared";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagePartRenderProps } from "../chat-message.types";
import { RuntimeTerragonMessage } from "./runtime-terragon-message";
import {
  TerragonMessageRenderProvider,
  type TerragonMessageRenderContext,
  TerragonThreadProvider,
  type TerragonThreadContext,
} from "./thread-context";

vi.mock("@/server-actions/transcribe-audio", () => ({
  transcribeAudio: vi.fn(),
}));

const messagePartSpy = vi.hoisted(() => vi.fn());

vi.mock("../message-part", async () => {
  const { createElement: createReactElement } = await import("react");
  return {
    MessagePart: ({ part }: { part: UIPart }) => {
      messagePartSpy(part);
      return createReactElement(
        "div",
        { "data-testid": "message-part" },
        part.type,
      );
    },
  };
});

const baseMessagePartProps: MessagePartRenderProps = {
  githubRepoFullName: "acme/app",
  branchName: "feature/streaming",
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
    branchName: "feature/streaming",
  },
};

function makeCtx(): TerragonThreadContext {
  return {
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
  };
}

function makeRenderCtx(
  overrides: Partial<TerragonMessageRenderContext> = {},
): TerragonMessageRenderContext {
  return {
    isAgentWorking: true,
    artifactDescriptors: [],
    onOpenArtifact: vi.fn(),
    planOccurrences: new Map(),
    redoDialogData: undefined,
    forkDialogData: undefined,
    messagePartProps: baseMessagePartProps,
    ...overrides,
  };
}

function makeMessage(parts: UIPart[]): UIMessage {
  return {
    id: "agent-turn",
    role: "agent",
    agent: "codex",
    parts,
    sourceMessageIds: ["agent-text-1", "agent-tool-1", "agent-text-2"],
  };
}

const stableToolPart: UIPart = {
  type: "tool",
  id: "tool-1",
  agent: "codex",
  name: "Bash",
  parameters: { command: "pwd" },
  status: "completed",
  result: "ok",
  parts: [],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderMessage({
  message,
  ctx,
  renderCtx,
}: {
  message: UIMessage;
  ctx: TerragonThreadContext;
  renderCtx: TerragonMessageRenderContext;
}) {
  return createElement(
    TerragonThreadProvider,
    { value: ctx },
    createElement(
      TerragonMessageRenderProvider,
      { value: renderCtx },
      createElement(RuntimeTerragonMessage, {
        message,
        messageIndex: 0,
        isLatestMessage: true,
        isFirstUserMessage: false,
        isLatestAgentMessage: true,
      }),
    ),
  );
}

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
  messagePartSpy.mockClear();
  vi.restoreAllMocks();
});

describe("RuntimeTerragonMessage live part rendering", () => {
  it("does not remap stable earlier parts when the live tail text changes", () => {
    const ctx = makeCtx();
    const renderCtx = makeRenderCtx();
    const initialMessage = makeMessage([
      stableToolPart,
      { type: "text", text: "streaming" },
    ]);
    mount(renderMessage({ message: initialMessage, ctx, renderCtx }));

    expect(messagePartSpy).toHaveBeenCalledTimes(2);
    const callsAfterMount = messagePartSpy.mock.calls.length;

    update(
      renderMessage({
        message: makeMessage([
          stableToolPart,
          { type: "text", text: "streaming more" },
        ]),
        ctx,
        renderCtx,
      }),
    );

    expect(messagePartSpy.mock.calls.length - callsAfterMount).toBe(1);
    expect(messagePartSpy).toHaveBeenLastCalledWith({
      type: "text",
      text: "streaming more",
    });
  });

  it("does not rerender runtime rows when only the broad thread context changes", () => {
    const message = makeMessage([{ type: "text", text: "stable" }]);
    const renderCtx = makeRenderCtx();

    mount(renderMessage({ message, ctx: makeCtx(), renderCtx }));
    expect(messagePartSpy).toHaveBeenCalledTimes(1);
    const callsAfterMount = messagePartSpy.mock.calls.length;

    update(renderMessage({ message, ctx: makeCtx(), renderCtx }));

    expect(messagePartSpy.mock.calls.length - callsAfterMount).toBe(0);
  });
});
