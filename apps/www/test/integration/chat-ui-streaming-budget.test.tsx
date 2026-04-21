/* @vitest-environment jsdom */

/**
 * Integration-level streaming render budget test (Option B of the
 * "streaming isn't working and thousands of rerenders" diagnosis).
 *
 * Mounts the REAL `ChatUI` component with:
 *   - A test-controlled fake `HttpAgent` (test pushes AG-UI events directly
 *     via `__pushEvent`, bypassing the real SSE fetch loop).
 *   - Static `useShellFromCollection` / `useChatFromCollection` mocks that
 *     return fixed minimal `ThreadPageShell` / `ThreadPageChat` snapshots.
 *   - A real `QueryClientProvider` (no network — all relevant hooks are
 *     either mocked or satisfied by seeded collection reads).
 *
 * Measurement:
 *   1. Spy on `useTerragonThread` — every row body execution increments the
 *      spy (proven pattern from `memo-rerenders.test.tsx`). We also count
 *      per-message-id calls to distinguish streaming row from historical
 *      rows.
 *   2. `<React.Profiler>` wraps the tree; `onRender` counts `phase==="update"`
 *      commits across the whole subtree. Captures effect-loop regressions
 *      that would not show up in the per-row spy.
 *
 * The tests assert empirical ceilings on (hook calls, commits) for streaming
 * workloads. If the production rerender cascade is a real bug, Test 1 will
 * blow past the bound; if not, the numbers will document the current budget.
 */

import { act, createElement, Profiler, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/core";
import type { HttpAgent } from "@ag-ui/client";
import type {
  ThreadPageChat,
  ThreadPageShell,
  DBMessage,
} from "@terragon/shared";

// ---------------------------------------------------------------------------
// Mocks — these MUST come before any imports that transitively touch them.
// ---------------------------------------------------------------------------

// Transcribe-audio loads `openai` at module time; crashes in jsdom.
vi.mock("@/server-actions/transcribe-audio", () => ({
  transcribeAudio: vi.fn(),
}));

// Fake AG-UI agent registry. Each `useAgUiTransport` call produces (or
// reuses) a single fake agent keyed by `threadId:threadChatId`. Tests get
// access to the agent via `getFakeAgent()` and push synthetic events via
// `__pushEvent`.
type FakeAgent = {
  subscribers: Array<(params: { event: BaseEvent }) => void>;
  subscribe: (s: { onEvent?: (params: { event: BaseEvent }) => void }) => {
    unsubscribe: () => void;
  };
  __pushEvent: (event: BaseEvent) => void;
};

const fakeAgentRegistry = new Map<string, FakeAgent>();

function createFakeAgent(): FakeAgent {
  const fake: FakeAgent = {
    subscribers: [],
    subscribe: (s) => {
      const handler = s.onEvent;
      if (handler) fake.subscribers.push(handler);
      return {
        unsubscribe: () => {
          if (handler) {
            const idx = fake.subscribers.indexOf(handler);
            if (idx >= 0) fake.subscribers.splice(idx, 1);
          }
        },
      };
    },
    __pushEvent: (event) => {
      for (const sub of [...fake.subscribers]) sub({ event });
    },
  };
  return fake;
}

function getFakeAgent(threadId: string, threadChatId: string): FakeAgent {
  const key = `${threadId}:${threadChatId}`;
  let agent = fakeAgentRegistry.get(key);
  if (!agent) {
    agent = createFakeAgent();
    fakeAgentRegistry.set(key, agent);
  }
  return agent;
}

vi.mock("@/hooks/use-ag-ui-transport", () => ({
  useAgUiTransport: (args: {
    threadId: string;
    threadChatId: string | null;
  }): HttpAgent | null => {
    if (!args.threadChatId) return null;
    return getFakeAgent(
      args.threadId,
      args.threadChatId,
    ) as unknown as HttpAgent;
  },
}));

// Collection hooks — return fixed snapshots; seed* functions are no-ops.
const mockShellState: { current: ThreadPageShell | null } = { current: null };
const mockChatState: { current: ThreadPageChat | null } = { current: null };

vi.mock("@/collections/thread-shell-collection", () => ({
  seedShell: vi.fn(),
  useShellFromCollection: () => mockShellState.current ?? undefined,
  getThreadShellCollection: vi.fn(),
  applyShellPatchToCollection: vi.fn(),
}));

vi.mock("@/collections/thread-chat-collection", () => ({
  seedChat: vi.fn(),
  useChatFromCollection: () => mockChatState.current ?? undefined,
  getThreadChatCollection: vi.fn(),
  applyChatPatchToCollection: vi.fn(),
}));

// Delivery-loop status: always "no data".
vi.mock("@/queries/delivery-loop-status-queries", () => ({
  deliveryLoopStatusQueryKeys: {
    detail: (id: string) => ["delivery-loop-status", "detail", id],
  },
  useDeliveryLoopStatusQuery: () => ({ data: undefined }),
  deliveryLoopStatusQueryOptions: (id: string) => ({
    queryKey: ["delivery-loop-status", "detail", id],
    queryFn: async () => undefined,
  }),
}));

// Feature flag hook — default off for unknown flags, keep contextUsageChip off.
vi.mock("@/hooks/use-feature-flag", () => ({
  useFeatureFlag: () => false,
}));

// Platform hook: force "desktop" stable value.
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => "desktop",
}));

// Document visibility — always true.
vi.mock("@/hooks/useDocumentVisibility", () => ({
  useDocumentVisibility: () => true,
}));

// Sidebar / thread-list hooks used by ChatHeader.
vi.mock("@/components/ui/sidebar", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useSidebar: () => ({
      state: "expanded",
      open: true,
      setOpen: vi.fn(),
      openMobile: false,
      setOpenMobile: vi.fn(),
      isMobile: false,
      toggleSidebar: vi.fn(),
    }),
    SidebarTrigger: (() => null) as unknown as typeof actual.SidebarTrigger,
  };
});

vi.mock("@/components/thread-list/use-collapsible-thread-list", () => ({
  useCollapsibleThreadList: () => ({ isCollapsed: false, toggle: vi.fn() }),
}));

// `useThreadMetaEvents` — does a real AG-UI subscription on the HttpAgent;
// fine with our fake agent, but skip to avoid extra subscribe traffic that
// would muddy the commit budget. It returns a state object.
vi.mock("@/components/chat/meta-chips/use-thread-meta-events", () => ({
  useThreadMetaEvents: () => ({
    snapshot: {
      tokenUsage: null,
      rateLimits: null,
      modelReroute: null,
      mcpServerStatus: {},
      bootSteps: [],
    },
  }),
}));

// Stabilize the scroll hook — real impl pokes document.readyState and
// performance entries; fine under jsdom but has timers/effects.
vi.mock("@/hooks/useScrollToBottom", () => ({
  useScrollToBottom: () => ({
    messagesEndRef: { current: null },
    isAtBottom: true,
    forceScrollToBottom: vi.fn(),
  }),
}));

// Jotai cookie atoms: real impl reads cookies. Override just the
// secondaryPane atom; leave the rest.
vi.mock("@/atoms/user-cookies", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const { atom } = (await import("jotai")) as typeof import("jotai");
  return {
    ...actual,
    secondaryPaneClosedAtom: atom(true),
  };
});

// Polyfills for jsdom.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
    root = null;
    rootMargin = "";
    thresholds = [];
  } as unknown as typeof IntersectionObserver;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
// Required so React 19 honors `act(...)` calls in this jsdom test file.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Imports AFTER mocks.
// ---------------------------------------------------------------------------

import ChatUI from "@/components/chat/chat-ui";
import * as threadContextModule from "@/components/chat/assistant-ui/thread-context";

// ---------------------------------------------------------------------------
// Fixture factories.
// ---------------------------------------------------------------------------

const THREAD_ID = "thread-test";
const CHAT_ID = "chat-test";
const TS = new Date("2026-04-20T00:00:00.000Z");

function makeShell(): ThreadPageShell {
  return {
    id: THREAD_ID,
    userId: "user-1",
    name: "Streaming budget test",
    branchName: "feature/streaming",
    repoBaseBranchName: "main",
    githubRepoFullName: "acme/app",
    automationId: null,
    codesandboxId: "sandbox-1",
    sandboxProvider: "e2b",
    sandboxSize: "small",
    bootingSubstatus: null,
    archived: false,
    createdAt: TS,
    updatedAt: TS,
    visibility: "private",
    prStatus: null,
    prChecksStatus: null,
    authorName: "Tyler",
    authorImage: null,
    githubPRNumber: null,
    githubIssueNumber: null,
    sandboxStatus: "running",
    gitDiffStats: null,
    parentThreadName: null,
    parentThreadId: null,
    parentToolId: null,
    draftMessage: null,
    skipSetup: false,
    disableGitCheckpointing: false,
    sourceType: "www",
    sourceMetadata: { type: "www", deliveryLoopOptIn: false },
    version: 1,
    isUnread: false,
    messageSeq: 0,
    childThreads: [],
    hasGitDiff: false,
    primaryThreadChatId: CHAT_ID,
    primaryThreadChat: {
      id: CHAT_ID,
      threadId: THREAD_ID,
      agent: "claudeCode",
      agentVersion: 1,
      status: "working",
      errorMessage: null,
      errorMessageInfo: null,
      scheduleAt: null,
      reattemptQueueAt: null,
      contextLength: null,
      permissionMode: "allowAll",
      isUnread: false,
      messageSeq: 0,
      updatedAt: TS,
    },
  };
}

function makeChat(messages: DBMessage[]): ThreadPageChat {
  return {
    id: CHAT_ID,
    userId: "user-1",
    threadId: THREAD_ID,
    title: null,
    createdAt: TS,
    updatedAt: TS,
    agent: "claudeCode",
    agentVersion: 1,
    status: "working",
    sessionId: null,
    errorMessage: null,
    errorMessageInfo: null,
    scheduleAt: null,
    reattemptQueueAt: null,
    contextLength: null,
    permissionMode: "allowAll",
    codexPreviousResponseId: null,
    isUnread: false,
    messageSeq: 0,
    messages,
    projectedMessages: messages,
    queuedMessages: [],
    messageCount: messages.length,
    chatSequence: 0,
    patchVersion: 0,
  };
}

function makeHistoricalMessages(): DBMessage[] {
  return [
    {
      type: "user",
      model: null,
      parts: [{ type: "text", text: "first user message" }],
    },
    {
      type: "agent",
      parent_tool_use_id: null,
      parts: [{ type: "text", text: "first agent reply" }],
    },
    {
      type: "user",
      model: null,
      parts: [{ type: "text", text: "second user message" }],
    },
    {
      type: "agent",
      parent_tool_use_id: null,
      parts: [{ type: "text", text: "second agent reply" }],
    },
    {
      type: "tool-call",
      id: "tc-1",
      name: "Bash",
      parameters: { command: "ls" },
      parent_tool_use_id: null,
      status: "completed",
      startedAt: TS.toISOString(),
      completedAt: TS.toISOString(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Render harness.
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient | null = null;

let totalCommits = 0;
let mountCommits = 0;

function resetCommitCounters() {
  totalCommits = 0;
  mountCommits = 0;
}

function onRender(
  _id: string,
  phase: "mount" | "update" | "nested-update",
): void {
  if (phase === "update" || phase === "nested-update") {
    totalCommits += 1;
  } else {
    mountCommits += 1;
  }
}

function mount(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });

  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: queryClient! },
        createElement(Profiler, { id: "chat-ui-root", onRender }, element),
      ),
    );
  });
}

function pushEvent(event: BaseEvent) {
  const agent = getFakeAgent(THREAD_ID, CHAT_ID);
  act(() => {
    agent.__pushEvent(event);
  });
}

beforeEach(() => {
  resetCommitCounters();
  fakeAgentRegistry.clear();
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
  queryClient?.clear();
  queryClient = null;
  mockShellState.current = null;
  mockChatState.current = null;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Spy helpers for `useTerragonThread`.
// ---------------------------------------------------------------------------

/**
 * Spy that both (a) counts total row-body executions and (b) tags each call
 * with the nearest ancestor message id by reading a tracker ref we update
 * in a wrapper. But we can't easily inject ancestor id; instead, we count
 * total row-body calls here and rely on the `Profiler` to give a global
 * commit count. For per-message attribution, Test 2 uses the fact that
 * historical rows bailing out simply do not call `useTerragonThread`; we
 * compare deltas instead of absolute per-row counts.
 */
function spyOnThreadHook() {
  return vi.spyOn(threadContextModule, "useTerragonThread");
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("ChatUI streaming render budget", () => {
  it("100 text deltas trigger O(N) row body executions (Test 1)", async () => {
    const shell = makeShell();
    const initialMessages = makeHistoricalMessages(); // 5 messages
    const chat = makeChat(initialMessages);
    mockShellState.current = shell;
    mockChatState.current = chat;

    const hookSpy = spyOnThreadHook();

    mount(createElement(ChatUI, { threadId: THREAD_ID, isReadOnly: true }));

    // Let initial mount and any queued effects settle.
    await act(async () => {
      await Promise.resolve();
    });

    const initialHookCalls = hookSpy.mock.calls.length;
    const initialMountCommits = mountCommits;
    const initialTotalCommits = totalCommits;

    // Reset counters post-mount so we measure ONLY the streaming workload.
    hookSpy.mockClear();
    resetCommitCounters();

    // Push 100 events targeting a new streaming assistant message:
    // 1 TEXT_MESSAGE_START + 99 TEXT_MESSAGE_CONTENT.
    const STREAM_ID = "stream-msg-1";
    pushEvent({
      type: EventType.TEXT_MESSAGE_START,
      messageId: STREAM_ID,
      role: "assistant",
    } as BaseEvent);

    for (let i = 0; i < 99; i++) {
      pushEvent({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: STREAM_ID,
        delta: "x",
      } as BaseEvent);
    }

    await act(async () => {
      await Promise.resolve();
    });

    const deltaHookCalls = hookSpy.mock.calls.length;
    const deltaTotalCommits = totalCommits;

    // eslint-disable-next-line no-console
    console.log("[Test 1] measured:", {
      historyMessages: initialMessages.length,
      initialHookCalls,
      initialMountCommits,
      initialTotalCommits,
      deltaHookCalls,
      deltaTotalCommits,
    });

    // Bound: ~100 hook calls for the streaming row + at most 1 rerender
    // per existing row as the new message first appears. 5 history rows
    // + 1 streaming row; 100 events → ≤ 100 + 5.
    expect(deltaHookCalls).toBeLessThanOrEqual(100 + initialMessages.length);
    // All-subtree commit ceiling. Observed baseline: ~3 commits/delta
    // (~299 for 100 events). Bound is set well above baseline so the test
    // catches an order-of-magnitude regression (e.g. effect loop adding
    // 5+ commits/delta) without flaking on incidental scheduling.
    expect(deltaTotalCommits).toBeLessThanOrEqual(500);
  });

  it("historical rows do not rerender on steady streaming (Test 2)", async () => {
    // 10 historical messages.
    const historical: DBMessage[] = [];
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) {
        historical.push({
          type: "user",
          model: null,
          parts: [{ type: "text", text: `user msg ${i}` }],
        });
      } else {
        historical.push({
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: `agent msg ${i}` }],
        });
      }
    }

    mockShellState.current = makeShell();
    mockChatState.current = makeChat(historical);

    const hookSpy = spyOnThreadHook();

    mount(createElement(ChatUI, { threadId: THREAD_ID, isReadOnly: true }));
    await act(async () => {
      await Promise.resolve();
    });

    // Start a new streaming message.
    const STREAM_ID = "stream-2";
    pushEvent({
      type: EventType.TEXT_MESSAGE_START,
      messageId: STREAM_ID,
      role: "assistant",
    } as BaseEvent);

    await act(async () => {
      await Promise.resolve();
    });

    // Reset — now we measure ONLY the steady-state deltas. Any hook call
    // here is a row-body execution during deltas-only streaming.
    hookSpy.mockClear();
    resetCommitCounters();

    for (let i = 0; i < 50; i++) {
      pushEvent({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: STREAM_ID,
        delta: "y",
      } as BaseEvent);
    }

    await act(async () => {
      await Promise.resolve();
    });

    const steadyDeltaHookCalls = hookSpy.mock.calls.length;
    const steadyDeltaCommits = totalCommits;

    // eslint-disable-next-line no-console
    console.log("[Test 2] measured:", {
      historyMessages: historical.length,
      steadyDeltaHookCalls,
      steadyDeltaCommits,
    });

    // Streaming row is 1 UIMessage. If historical rows correctly bail out,
    // every delta produces exactly 1 hook call (the streaming row). 50
    // deltas → 50 hook calls. We give slack for any global wrappers that
    // might also consume the hook.
    //
    // If this exceeds `50 * (history.length + 1)` it strongly suggests a
    // memo bail-out regression — every row rerendering per delta.
    expect(steadyDeltaHookCalls).toBeLessThanOrEqual(50 + historical.length);
    // Steady-state commit budget. Observed: ~152 commits for 50 deltas
    // (~3/delta, same as Test 1). Set ceiling above baseline to catch
    // regressions.
    expect(steadyDeltaCommits).toBeLessThanOrEqual(300);
  });

  it("no effect loops during single delta (Test 3)", async () => {
    mockShellState.current = makeShell();
    mockChatState.current = makeChat([
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "hi" }],
      },
    ]);

    mount(createElement(ChatUI, { threadId: THREAD_ID, isReadOnly: true }));
    await act(async () => {
      await Promise.resolve();
    });

    const STREAM_ID = "stream-3";
    pushEvent({
      type: EventType.TEXT_MESSAGE_START,
      messageId: STREAM_ID,
      role: "assistant",
    } as BaseEvent);
    await act(async () => {
      await Promise.resolve();
    });

    resetCommitCounters();

    // Single delta event — if there's an effect loop, commits will explode.
    pushEvent({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: STREAM_ID,
      delta: "z",
    } as BaseEvent);

    await act(async () => {
      await Promise.resolve();
    });

    // eslint-disable-next-line no-console
    console.log("[Test 3] single-delta commits:", totalCommits);

    // Expect a small finite number. >100 would indicate an effect loop.
    expect(totalCommits).toBeLessThanOrEqual(20);
  });
});
