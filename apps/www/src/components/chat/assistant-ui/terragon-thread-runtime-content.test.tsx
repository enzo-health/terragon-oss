/* @vitest-environment jsdom */

import type { ThreadMessage } from "@assistant-ui/react";
import type {
  DBUserMessage,
  ThreadInfoFull,
  UIMessage,
} from "@terragon/shared";
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
      messages: UIMessage[];
      isRuntimeHydrating: boolean;
      showWorkingMessage: boolean;
    }>,
);

vi.mock("@assistant-ui/react", () => ({
  useAuiState: (
    selector: (state: typeof runtimeState) => ThreadMessage[] | boolean,
  ) => selector(runtimeState),
}));

vi.mock("./terragon-transcript-surface", async () => {
  const React = await import("react");
  return {
    TerragonTranscriptSurface: (props: {
      messages: UIMessage[];
      isRuntimeHydrating: boolean;
      showWorkingMessage: boolean;
    }) => {
      transcriptSurfaceProps.push(props);
      return React.createElement(
        "div",
        { "data-testid": "runtime-transcript-surface" },
        props.messages.flatMap((message) =>
          message.parts.map((part) =>
            part.type === "text" ? part.text : part.type,
          ),
        ),
      );
    },
  };
});

import { TerragonThreadRuntimeContent } from "./terragon-thread-runtime-content";

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

  it("feeds active chat transcript rendering from assistant-ui runtime state, not DB view-model messages", () => {
    const messagesRef = { current: [] as UIMessage[] };

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
          messagesRef,
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
    expect(transcriptSurfaceProps[0]?.messages).toEqual([
      {
        id: "runtime-user-1",
        role: "user",
        parts: [{ type: "text", text: "Runtime-owned transcript renders" }],
      },
    ]);
    expect(messagesRef.current).toBe(transcriptSurfaceProps[0]?.messages);
    expect(container!.textContent).toContain(
      "Runtime-owned transcript renders",
    );
    expect(container!.textContent).not.toContain(
      "DB threadViewModel.messages must not render",
    );
  });

  it("layers optimistic user messages onto the assistant-ui transcript", () => {
    const messagesRef = { current: [] as UIMessage[] };

    mount(
      createElement(TerragonThreadRuntimeContent, {
        lifecycleMessages: [],
        optimisticUserMessages: [
          {
            id: "user-optimistic-chat-1-1",
            role: "user",
            parts: [{ type: "text", text: "Optimistic follow-up renders" }],
            timestamp: new Date(1).toISOString(),
            model: null,
          },
        ],
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
          messagesRef,
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
    expect(transcriptSurfaceProps[0]?.messages).toEqual([
      {
        id: "runtime-user-1",
        role: "user",
        parts: [{ type: "text", text: "Runtime-owned transcript renders" }],
      },
      {
        id: "user-optimistic-chat-1-1",
        role: "user",
        parts: [{ type: "text", text: "Optimistic follow-up renders" }],
        timestamp: new Date(1).toISOString(),
        model: null,
      },
    ]);
    expect(messagesRef.current).toBe(transcriptSurfaceProps[0]?.messages);
    expect(container!.textContent).toContain("Optimistic follow-up renders");
    expect(container!.textContent).not.toContain(
      "DB threadViewModel.messages must not render",
    );
  });

  it("does not use DB view-model messages while runtime history is hydrating", () => {
    runtimeState.thread.messages = [];
    runtimeState.thread.isLoading = true;
    const messagesRef = { current: [] as UIMessage[] };

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
          messagesRef,
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
    expect(transcriptSurfaceProps[0]?.messages).toEqual([]);
    expect(messagesRef.current).toBe(transcriptSurfaceProps[0]?.messages);
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
    const messagesRef = { current: [] as UIMessage[] };

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
          messagesRef,
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
});
