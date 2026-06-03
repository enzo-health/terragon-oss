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

import {
  HttpAgent,
  type AgentSubscriber,
  type AgentSubscriberParams,
} from "@ag-ui/client";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  DBMessage,
  ThreadPageChat,
  ThreadPageShell,
} from "@terragon/shared";
import { act, createElement, Profiler, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbMessagesToAgUiMessages } from "@/components/chat/db-messages-to-ag-ui";

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
  subscribers: Array<(event: BaseEvent) => void>;
  pendingDelta: BaseEvent | null;
  scheduledFlush: ReturnType<typeof setTimeout> | null;
  subscribe: (s: AgentSubscriber) => {
    unsubscribe: () => void;
  };
  runAgent: (
    input: Parameters<HttpAgent["runAgent"]>[0],
    subscriber: AgentSubscriber,
  ) => Promise<void>;
  __pushEvent: (event: BaseEvent) => void;
  __flush: () => void;
};

type CoalescableBudgetDelta = BaseEvent & {
  type:
    | EventType.TEXT_MESSAGE_CONTENT
    | EventType.REASONING_MESSAGE_CONTENT
    | EventType.TOOL_CALL_ARGS;
  delta: string;
} & ({ messageId: string } | { toolCallId: string });

function isCoalescableBudgetDelta(
  event: BaseEvent,
): event is CoalescableBudgetDelta {
  return (
    (event.type === EventType.TEXT_MESSAGE_CONTENT ||
      event.type === EventType.REASONING_MESSAGE_CONTENT ||
      event.type === EventType.TOOL_CALL_ARGS) &&
    "delta" in event &&
    typeof event.delta === "string" &&
    (("messageId" in event && typeof event.messageId === "string") ||
      ("toolCallId" in event && typeof event.toolCallId === "string"))
  );
}

function coalescableBudgetKey(event: CoalescableBudgetDelta): string {
  if ("messageId" in event) {
    return `${event.type}:${event.messageId}`;
  }
  return `${event.type}:${event.toolCallId}`;
}

const fakeAgentRegistry = new Map<string, FakeAgent>();

function createRunAgentInput(
  input: Parameters<HttpAgent["runAgent"]>[0],
): RunAgentInput {
  return {
    threadId: "streaming-budget-thread",
    runId: input?.runId ?? "streaming-budget-run",
    state: {},
    messages: [],
    tools: input?.tools ?? [],
    context: input?.context ?? [],
    forwardedProps: input?.forwardedProps ?? {},
  };
}

function createSubscriberParams({
  agent,
  input,
}: {
  agent: HttpAgent;
  input: RunAgentInput;
}): AgentSubscriberParams {
  return {
    messages: input.messages,
    state: input.state,
    agent,
    input,
  };
}

function createFakeAgent(): FakeAgent {
  const subscriberAgent = new HttpAgent({ url: "/test-ag-ui" });
  const fake: FakeAgent = {
    subscribers: [],
    pendingDelta: null,
    scheduledFlush: null,
    subscribe: (s) => {
      const handler = s.onEvent;
      const dispatch = handler
        ? (event: BaseEvent) => {
            const input = createRunAgentInput(undefined);
            return handler({
              ...createSubscriberParams({ agent: subscriberAgent, input }),
              event,
            });
          }
        : undefined;
      if (dispatch) fake.subscribers.push(dispatch);
      return {
        unsubscribe: () => {
          if (dispatch) {
            const idx = fake.subscribers.indexOf(dispatch);
            if (idx >= 0) fake.subscribers.splice(idx, 1);
          }
        },
      };
    },
    runAgent: async (input, subscriber) => {
      const runInput = createRunAgentInput(input);
      fake.subscribers.push((event) => {
        const params = createSubscriberParams({
          agent: subscriberAgent,
          input: runInput,
        });
        subscriber.onEvent?.({ ...params, event });
        if (
          event.type === EventType.RUN_FINISHED ||
          event.type === EventType.RUN_ERROR
        ) {
          subscriber.onRunFinalized?.(params);
        }
      });
    },
    __flush: () => {
      if (fake.scheduledFlush !== null) {
        clearTimeout(fake.scheduledFlush);
        fake.scheduledFlush = null;
      }
      if (!fake.pendingDelta) return;
      const event = fake.pendingDelta;
      fake.pendingDelta = null;
      for (const sub of [...fake.subscribers]) sub(event);
    },
    __pushEvent: (event) => {
      if (isCoalescableBudgetDelta(event)) {
        if (
          fake.pendingDelta &&
          isCoalescableBudgetDelta(fake.pendingDelta) &&
          coalescableBudgetKey(fake.pendingDelta) ===
            coalescableBudgetKey(event)
        ) {
          fake.pendingDelta = {
            ...event,
            delta: `${fake.pendingDelta.delta}${event.delta}`,
          } as BaseEvent;
          return;
        }
        fake.__flush();
        fake.pendingDelta = event;
        fake.scheduledFlush = setTimeout(fake.__flush, 16);
        return;
      }

      fake.__flush();
      for (const sub of [...fake.subscribers]) sub(event);
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
  shouldUseSyntheticAgUiBenchmarkStream: () => false,
  useAgUiTransport: (args: {
    threadId: string;
    threadChatId: string | null;
  }) => {
    if (!args.threadChatId) {
      return { agent: null, setReplayCursor: vi.fn() };
    }
    return {
      agent: getFakeAgent(
        args.threadId,
        args.threadChatId,
      ) as unknown as HttpAgent,
      setReplayCursor: vi.fn(),
    };
  },
}));

// Collection hooks — return fixed snapshots; seed* functions are no-ops.
const mockShellState = vi.hoisted((): { current: ThreadPageShell | null } => ({
  current: null,
}));
const mockChatState = vi.hoisted((): { current: ThreadPageChat | null } => ({
  current: null,
}));

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

vi.mock("@/components/chat/thread-provider", async () => {
  const React = await import("react");
  type ThreadContextValue = {
    threadId: string;
    threadChatId: string;
    isReadOnly: boolean;
    shell: ThreadPageShell;
    threadChat: ThreadPageChat;
    threadChatSource: "collection";
  };
  const Context = React.createContext<ThreadContextValue | null>(null);
  return {
    ThreadProvider: ({
      threadId,
      isReadOnly,
      children,
    }: {
      threadId: string;
      isReadOnly: boolean;
      children: React.ReactNode;
    }) => {
      const shell = mockShellState.current;
      const threadChat = mockChatState.current;
      if (!shell || !threadChat) {
        return React.createElement("div", null, "Loading task...");
      }
      return React.createElement(
        Context.Provider,
        {
          value: {
            threadId,
            threadChatId: shell.primaryThreadChatId,
            isReadOnly,
            shell,
            threadChat,
            threadChatSource: "collection",
          },
        },
        children,
      );
    },
    useThreadContext: () => {
      const ctx = React.useContext(Context);
      if (!ctx) {
        throw new Error(
          "useThreadContext must be used within <ThreadProvider/>",
        );
      }
      return ctx;
    },
  };
});

vi.mock("@/collections/thread-transcript-collection", () => ({
  seedTranscript: vi.fn(),
  getCachedTranscript: vi.fn(() => undefined),
  invalidateCachedTranscript: vi.fn(),
  getThreadTranscriptCollection: vi.fn(),
}));

vi.mock("@/components/chat/use-thread-page-realtime-sync", () => ({
  useThreadPageRealtimeSync: vi.fn(),
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

import * as threadContextModule from "@/components/chat/assistant-ui/thread-context";
import ChatUI, {
  loadAgUiHistoryMessagesForRuntime,
} from "@/components/chat/chat-ui";
import { getCachedTranscript } from "@/collections/thread-transcript-collection";

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
    sourceMetadata: { type: "www" },
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

function flushTransportFrame() {
  const agent = getFakeAgent(THREAD_ID, CHAT_ID);
  act(() => {
    agent.__flush();
  });
}

beforeEach(() => {
  resetCommitCounters();
  fakeAgentRegistry.clear();
  vi.mocked(getCachedTranscript).mockImplementation(() => {
    const projectedMessages = mockChatState.current?.projectedMessages ?? [];
    return {
      messages: dbMessagesToAgUiMessages(projectedMessages as DBMessage[]),
      lastSeq: -1,
    };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const projectedMessages = mockChatState.current?.projectedMessages ?? [];
      return new Response(
        JSON.stringify({
          messages: dbMessagesToAgUiMessages(projectedMessages as DBMessage[]),
          lastSeq: -1,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }),
  );
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
  vi.unstubAllGlobals();
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
  it("bypasses cached transcript history after a run finalizes", async () => {
    vi.mocked(getCachedTranscript).mockReturnValue({
      messages: [{ id: "stale-user", role: "user", content: "stale only" }],
      lastSeq: 1,
    });

    const result = await loadAgUiHistoryMessagesForRuntime({
      threadId: THREAD_ID,
      threadChatId: CHAT_ID,
      isAgentCurrentlyWorking: false,
    });

    expect(getCachedTranscript).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("history=messages"),
      expect.any(Object),
    );
    expect(result.messages).toEqual([]);
  });

  it("falls back to projected messages when AG-UI history is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );

    const fallbackMessages = [
      { id: "user-fallback", role: "user", content: "fallback user" },
      {
        id: "assistant-fallback",
        role: "assistant",
        content: "fallback assistant",
      },
    ] as const;

    const result = await loadAgUiHistoryMessagesForRuntime({
      threadId: THREAD_ID,
      threadChatId: CHAT_ID,
      isAgentCurrentlyWorking: false,
      fallbackMessages: [...fallbackMessages],
    });

    expect(result).toEqual({
      messages: fallbackMessages,
      lastSeq: -1,
    });
  });

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
    flushTransportFrame();

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

    // The transport now coalesces token bursts before assistant-ui sees them.
    // A 99-delta burst should behave like one flushed content frame, plus
    // slack for global wrappers and the message-start commit.
    expect(deltaHookCalls).toBeLessThanOrEqual(initialMessages.length + 25);
    expect(deltaTotalCommits).toBeLessThanOrEqual(40);
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
    flushTransportFrame();

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

    // Burst deltas are frame-coalesced, so steady streaming should no longer
    // scale commits linearly with raw token count.
    expect(steadyDeltaHookCalls).toBeLessThanOrEqual(historical.length + 20);
    expect(steadyDeltaCommits).toBeLessThanOrEqual(35);
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

  it("100 tool argument deltas render by flushed frame, not raw fragment", async () => {
    mockShellState.current = makeShell();
    mockChatState.current = makeChat([
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "run the command" }],
      },
    ]);

    const hookSpy = spyOnThreadHook();

    mount(createElement(ChatUI, { threadId: THREAD_ID, isReadOnly: true }));
    await act(async () => {
      await Promise.resolve();
    });

    hookSpy.mockClear();
    resetCommitCounters();

    pushEvent({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool-stream-1",
      toolCallName: "Bash",
      parentMessageId: "assistant-tool-parent",
    } as BaseEvent);

    for (let i = 0; i < 100; i++) {
      pushEvent({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-stream-1",
        delta: i === 0 ? '{"command":"' : "x",
      } as BaseEvent);
    }
    flushTransportFrame();

    await act(async () => {
      await Promise.resolve();
    });

    expect(hookSpy.mock.calls.length).toBeLessThanOrEqual(30);
    expect(totalCommits).toBeLessThanOrEqual(45);
  });

  it("long markdown streaming stays bounded across repeated frames", async () => {
    const historical = makeHistoricalMessages();
    mockShellState.current = makeShell();
    mockChatState.current = makeChat(historical);

    const hookSpy = spyOnThreadHook();

    mount(createElement(ChatUI, { threadId: THREAD_ID, isReadOnly: true }));
    await act(async () => {
      await Promise.resolve();
    });

    const STREAM_ID = "stream-markdown-frames";
    pushEvent({
      type: EventType.TEXT_MESSAGE_START,
      messageId: STREAM_ID,
      role: "assistant",
    } as BaseEvent);
    await act(async () => {
      await Promise.resolve();
    });

    hookSpy.mockClear();
    resetCommitCounters();

    const chunks = [
      "## Scheduling overview\n\n",
      "Scheduling has three moving pieces that matter for operators.\n\n",
      "| Area | Responsibility |\n| --- | --- |\n",
      "| Intake | Capture task metadata and requested start time |\n",
      "| Queue | Keep runnable work ordered without starving retries |\n",
      "| Runner | Lease work and stream progress back to the thread |\n\n",
      "### Lifecycle\n\n",
      "1. A task enters the queue with a durable timestamp.\n",
      "2. The scheduler checks readiness and provider capacity.\n",
      "3. The runner claims a lease and starts the sandbox.\n",
      "4. Events stream back into the chat transcript.\n\n",
      "```ts\n",
      'type ScheduleState = "queued" | "running" | "done";\n',
      "const next = pickReadyTask(queue);\n",
      "```\n\n",
      "The important invariant is that every visible state has one writer.\n\n",
      "That keeps the UI predictable even while the answer is still growing.\n",
    ];

    for (const delta of chunks) {
      pushEvent({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: STREAM_ID,
        delta,
      } as BaseEvent);
      flushTransportFrame();
      await act(async () => {
        await Promise.resolve();
      });
    }

    const markdownFrameHookCalls = hookSpy.mock.calls.length;
    const markdownFrameCommits = totalCommits;

    // eslint-disable-next-line no-console
    console.log("[Test markdown frames] measured:", {
      historyMessages: historical.length,
      frames: chunks.length,
      markdownFrameHookCalls,
      markdownFrameCommits,
    });

    expect(markdownFrameHookCalls).toBeLessThanOrEqual(
      historical.length + chunks.length * 4,
    );
    expect(markdownFrameCommits).toBeLessThanOrEqual(chunks.length * 4);
  });
});

describe("ChatUI historical hydration contract", () => {
  it("does not render legacy transcript rows when `projectedMessages` is empty", async () => {
    // AG-UI-only invariant: historical transcript content must be sourced from
    // `projectedMessages` for canonical/AG-UI replay paths. Legacy `messages`
    // snapshots are not used as a fallback once projection is missing.
    const history = makeHistoricalMessages(); // 5 messages
    const shell = makeShell();
    // Mark the chat as complete so it matches the historical-chat shell shape
    // seen in the reported blank-UI failure.
    shell.primaryThreadChat = {
      ...shell.primaryThreadChat,
      status: "complete",
    };
    const chat: ThreadPageChat = {
      ...makeChat(history),
      status: "complete",
      projectedMessages: [],
    };
    mockShellState.current = shell;
    mockChatState.current = chat;

    mount(createElement(ChatUI, { threadId: THREAD_ID, isReadOnly: true }));
    await act(async () => {
      await Promise.resolve();
    });

    // Runtime-owned transcript hydration may still show a loading placeholder,
    // but legacy DB rows must not leak through as a fallback.
    expect(container?.textContent ?? "").not.toContain("first agent reply");
    expect(container?.textContent ?? "").not.toContain("second agent reply");
  });
});
