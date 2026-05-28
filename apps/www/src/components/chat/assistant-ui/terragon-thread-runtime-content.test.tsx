/* @vitest-environment jsdom */

import type {
  ThreadAssistantMessagePart,
  ThreadMessage,
} from "@assistant-ui/react";
import type { DBUserMessage, ThreadInfoFull } from "@terragon/shared";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MESSAGE_PART_PROPS } from "../chat-message.types";
import { createInitialThreadMetaSnapshot } from "../thread-view-model/snapshot-adapter";

const runtimeState = vi.hoisted(() => ({
  thread: {
    messages: [] as ThreadMessage[],
    isLoading: false,
  },
}));

const transcriptSurfaceProps = vi.hoisted(
  () =>
    [] as Array<{
      isRuntimeHydrating: boolean;
      passiveWait: { message: string; reason: null } | null;
      reserveWorkingMessageSlot: boolean;
      showWorkingMessage: boolean;
    }>,
);

vi.mock("@assistant-ui/react", () => ({
  useAuiState: (
    selector: (
      state: typeof runtimeState,
    ) => ThreadMessage[] | boolean | number,
  ) => selector(runtimeState),
}));

vi.mock("./terragon-transcript-surface", async () => {
  const React = await import("react");
  return {
    TerragonTranscriptSurface: (props: {
      isRuntimeHydrating: boolean;
      passiveWait: { message: string; reason: null } | null;
      reserveWorkingMessageSlot: boolean;
      showWorkingMessage: boolean;
    }) => {
      transcriptSurfaceProps.push(props);
      return React.createElement(
        "div",
        { "data-testid": "runtime-transcript-surface" },
        props.isRuntimeHydrating ? "hydrating" : "native transcript",
      );
    },
  };
});

import {
  getRuntimeThreadFlags,
  TerragonThreadRuntimeContent,
} from "./terragon-thread-runtime-content";

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

function makeThreadWithDbTranscriptSentinel(): ThreadInfoFull {
  const now = new Date(0);
  const dbTranscriptSentinel = {
    type: "user",
    model: null,
    parts: [
      {
        type: "text",
        text: "DB threadViewModel.messages must not render",
      },
    ],
    timestamp: now.toISOString(),
  } satisfies DBUserMessage;

  return {
    id: "thread-1",
    userId: "user-1",
    name: "Runtime-owned transcript guard",
    githubRepoFullName: "acme/app",
    repoBaseBranchName: "main",
    branchName: "feature/runtime-contract",
    githubPRNumber: null,
    githubIssueNumber: null,
    codesandboxId: null,
    sandboxProvider: "e2b",
    sandboxSize: null,
    sandboxStatus: null,
    bootingSubstatus: null,
    archived: false,
    automationId: null,
    parentThreadId: null,
    parentThreadName: null,
    parentToolId: null,
    draftMessage: null,
    disableGitCheckpointing: false,
    skipSetup: false,
    sourceType: "www",
    sourceMetadata: null,
    version: 1,
    messageSeq: 1,
    createdAt: now,
    updatedAt: now,
    gitDiff: null,
    gitDiffStats: null,
    prStatus: null,
    prChecksStatus: null,
    isUnread: false,
    visibility: null,
    authorName: null,
    authorImage: null,
    threadChats: [
      {
        id: "chat-1",
        userId: "user-1",
        threadId: "thread-1",
        title: null,
        createdAt: now,
        updatedAt: now,
        agent: "codex",
        agentVersion: 0,
        status: "complete",
        errorMessage: null,
        errorMessageInfo: null,
        scheduleAt: null,
        reattemptQueueAt: null,
        contextLength: null,
        permissionMode: "allowAll",
        isUnread: false,
        messages: [dbTranscriptSentinel],
        queuedMessages: null,
        sessionId: null,
        messageSeq: 1,
        codexPreviousResponseId: null,
      },
    ],
    childThreads: [],
  };
}

describe("TerragonThreadRuntimeContent", () => {
  beforeEach(() => {
    runtimeState.thread.messages = [
      {
        id: "runtime-user-1",
        role: "user",
        createdAt: new Date(0),
        content: [
          {
            type: "text",
            text: "Runtime-owned transcript renders",
          },
        ],
        attachments: [],
        metadata: { custom: {} },
      },
    ];
    runtimeState.thread.isLoading = false;
    transcriptSurfaceProps.length = 0;
  });

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

  it("keeps transcript rendering native instead of passing DB view-model messages", () => {
    mount(
      createElement(TerragonThreadRuntimeContent, {
        lifecycleMessages: [],
        threadStatus: "complete",
        thread: makeThreadWithDbTranscriptSentinel(),
        latestGitDiffTimestamp: null,
        isAgentWorking: false,
        artifactDescriptors: [],
        onOpenArtifact: vi.fn(),
        toolProps: {
          ...DEFAULT_MESSAGE_PART_PROPS.toolProps,
          threadId: "thread-1",
          threadChatId: "chat-1",
          githubRepoFullName: "acme/app",
          repoBaseBranchName: "main",
          branchName: "feature/runtime-contract",
        },
        hasCheckpoint: false,
        chatAgent: "codex",
        metaSnapshot: createInitialThreadMetaSnapshot(),
        reattemptQueueAt: null,
        threadChatId: "chat-1",
      }),
    );

    expect(transcriptSurfaceProps).toHaveLength(1);
    expect(container!.textContent).toContain("native transcript");
    expect(container!.textContent).not.toContain(
      "DB threadViewModel.messages must not render",
    );
  });

  it("does not use DB view-model messages while runtime history is hydrating", () => {
    runtimeState.thread.messages = [];
    runtimeState.thread.isLoading = true;

    mount(
      createElement(TerragonThreadRuntimeContent, {
        lifecycleMessages: [],
        threadStatus: "complete",
        thread: makeThreadWithDbTranscriptSentinel(),
        latestGitDiffTimestamp: null,
        isAgentWorking: false,
        artifactDescriptors: [],
        onOpenArtifact: vi.fn(),
        toolProps: {
          ...DEFAULT_MESSAGE_PART_PROPS.toolProps,
          threadId: "thread-1",
          threadChatId: "chat-1",
          githubRepoFullName: "acme/app",
          repoBaseBranchName: "main",
          branchName: "feature/runtime-contract",
        },
        hasCheckpoint: false,
        chatAgent: "codex",
        metaSnapshot: createInitialThreadMetaSnapshot(),
        reattemptQueueAt: null,
        threadChatId: "chat-1",
      }),
    );

    expect(transcriptSurfaceProps).toHaveLength(1);
    expect(transcriptSurfaceProps[0]?.isRuntimeHydrating).toBe(true);
    expect(container!.textContent).not.toContain(
      "DB threadViewModel.messages must not render",
    );
  });

  it("keeps the working indicator visible when no agent row has rendered content yet", () => {
    runtimeState.thread.messages = [
      {
        id: "runtime-user-1",
        role: "user",
        createdAt: new Date(0),
        content: [{ type: "text", text: "Run setup" }],
        attachments: [],
        metadata: { custom: {} },
      },
      {
        id: "assistant-placeholder",
        role: "assistant",
        createdAt: new Date(0),
        content: [],
        status: { type: "running" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ];
    mount(
      createElement(TerragonThreadRuntimeContent, {
        lifecycleMessages: [],
        threadStatus: "booting",
        thread: makeThreadWithDbTranscriptSentinel(),
        latestGitDiffTimestamp: null,
        isAgentWorking: true,
        artifactDescriptors: [],
        onOpenArtifact: vi.fn(),
        toolProps: {
          ...DEFAULT_MESSAGE_PART_PROPS.toolProps,
          threadId: "thread-1",
          threadChatId: "chat-1",
          githubRepoFullName: "acme/app",
          repoBaseBranchName: "main",
          branchName: "feature/runtime-contract",
        },
        hasCheckpoint: false,
        chatAgent: "codex",
        metaSnapshot: createInitialThreadMetaSnapshot(),
        reattemptQueueAt: null,
        threadChatId: "chat-1",
      }),
    );

    expect(transcriptSurfaceProps[0]?.showWorkingMessage).toBe(true);
  });

  it("keeps the working indicator visible after assistant text when no tool row is pending", () => {
    runtimeState.thread.messages = [
      {
        id: "assistant-text",
        role: "assistant",
        createdAt: new Date(0),
        content: [{ type: "text", text: "Streaming response" }],
        status: { type: "running" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ];
    mount(
      createElement(TerragonThreadRuntimeContent, {
        lifecycleMessages: [],
        threadStatus: "working",
        thread: makeThreadWithDbTranscriptSentinel(),
        latestGitDiffTimestamp: null,
        isAgentWorking: true,
        artifactDescriptors: [],
        onOpenArtifact: vi.fn(),
        toolProps: {
          ...DEFAULT_MESSAGE_PART_PROPS.toolProps,
          threadId: "thread-1",
          threadChatId: "chat-1",
          githubRepoFullName: "acme/app",
          repoBaseBranchName: "main",
          branchName: "feature/runtime-contract",
        },
        hasCheckpoint: false,
        chatAgent: "codex",
        metaSnapshot: createInitialThreadMetaSnapshot(),
        reattemptQueueAt: null,
        threadChatId: "chat-1",
      }),
    );

    expect(transcriptSurfaceProps[0]?.showWorkingMessage).toBe(true);
  });

  it("keeps passive wait available when a pending tool row suppresses animated status", () => {
    runtimeState.thread.messages = [
      {
        id: "assistant-tool",
        role: "assistant",
        createdAt: new Date(0),
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "Bash",
            args: { command: "pnpm test" },
            argsText: '{"command":"pnpm test"}',
          } satisfies ThreadAssistantMessagePart,
        ],
        status: { type: "running" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ];
    mount(
      createElement(TerragonThreadRuntimeContent, {
        lifecycleMessages: [],
        threadStatus: "working",
        thread: makeThreadWithDbTranscriptSentinel(),
        latestGitDiffTimestamp: null,
        isAgentWorking: true,
        artifactDescriptors: [],
        onOpenArtifact: vi.fn(),
        toolProps: {
          ...DEFAULT_MESSAGE_PART_PROPS.toolProps,
          threadId: "thread-1",
          threadChatId: "chat-1",
          githubRepoFullName: "acme/app",
          repoBaseBranchName: "main",
          branchName: "feature/runtime-contract",
        },
        hasCheckpoint: false,
        chatAgent: "codex",
        metaSnapshot: createInitialThreadMetaSnapshot(),
        reattemptQueueAt: null,
        threadChatId: "chat-1",
        threadChatUpdatedAt: new Date(Date.now() - 6 * 60 * 1_000),
      }),
    );

    expect(transcriptSurfaceProps[0]?.reserveWorkingMessageSlot).toBe(true);
    expect(transcriptSurfaceProps[0]?.showWorkingMessage).toBe(false);
    expect(transcriptSurfaceProps[0]?.passiveWait).toEqual({
      message: "Waiting for updates",
      reason: null,
    });
  });

  it("derives render flags from the newest useful assistant row", () => {
    const history: ThreadMessage[] = Array.from(
      { length: 1_000 },
      (_, index) => ({
        id: `user-${index}`,
        role: "user",
        createdAt: new Date(0),
        content: [{ type: "text", text: `Historical user ${index}` }],
        attachments: [],
        metadata: { custom: {} },
      }),
    );
    const messages: ThreadMessage[] = [
      ...history,
      {
        id: "assistant-tail",
        role: "assistant",
        createdAt: new Date(0),
        content: [
          { type: "text", text: "Streaming tail" },
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "Bash",
            args: { command: "pnpm test" },
            argsText: '{"command":"pnpm test"}',
          } satisfies ThreadAssistantMessagePart,
        ],
        status: { type: "running" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ];
    let visited = 0;

    const flags = getRuntimeThreadFlags(messages, () => {
      visited += 1;
    });

    expect(flags).toBe(3);
    expect(visited).toBe(1);
  });

  it("does not scan historical rows for pending tools after a plain assistant tail", () => {
    const messages: ThreadMessage[] = [
      ...Array.from({ length: 1_000 }, (_, index) => ({
        id: `historical-assistant-${index}`,
        role: "assistant" as const,
        createdAt: new Date(0),
        content: [{ type: "text" as const, text: `Historical ${index}` }],
        status: { type: "complete" as const, reason: "stop" as const },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      })),
      {
        id: "assistant-tail",
        role: "assistant",
        createdAt: new Date(0),
        content: [{ type: "text", text: "Streaming tail" }],
        status: { type: "running" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ];
    let visited = 0;

    const flags = getRuntimeThreadFlags(messages, () => {
      visited += 1;
    });

    expect(flags).toBe(1);
    expect(visited).toBe(1);
  });
});
