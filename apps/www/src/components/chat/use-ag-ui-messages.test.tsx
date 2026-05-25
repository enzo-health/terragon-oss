/* @vitest-environment jsdom */

import type { HttpAgent } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { UIMessage } from "@terragon/shared";
import { act, createElement, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordAgentTraceSpan } from "@/lib/agent-trace";
import {
  createInitialThreadViewModelState,
  projectThreadViewModel,
  threadViewModelReducer,
} from "./thread-view-model/reducer";
import { createEmptyThreadViewSnapshot } from "./thread-view-model/snapshot-adapter";
import {
  createThreadViewEventFromAgUiEvent,
  createThreadViewSidecarEventProjector,
  type ThreadViewEventForAgUi,
  useAgUiSidecarRouter,
  useThreadViewModel,
} from "./use-ag-ui-messages";

vi.mock("@/lib/agent-trace", () => ({
  recordAgentTraceSpan: vi.fn(),
}));

interface FakeAgent {
  subscribe: (subscriber: {
    onEvent?: (params: { event: BaseEvent }) => void;
  }) => { unsubscribe: () => void };
  emit: (event: BaseEvent) => void;
  subscribers: Array<(params: { event: BaseEvent }) => void>;
  unsubscribeCount: number;
}

function createFakeAgent(): FakeAgent {
  const fake: FakeAgent = {
    subscribers: [],
    unsubscribeCount: 0,
    subscribe: (subscriber) => {
      const handler = subscriber.onEvent;
      if (handler) fake.subscribers.push(handler);
      return {
        unsubscribe: () => {
          fake.unsubscribeCount += 1;
          if (handler) {
            const idx = fake.subscribers.indexOf(handler);
            if (idx >= 0) fake.subscribers.splice(idx, 1);
          }
        },
      };
    },
    emit: (event) => {
      for (const sub of [...fake.subscribers]) sub({ event });
    },
  };
  return fake;
}

function asHttpAgent(fake: FakeAgent): HttpAgent {
  return fake as unknown as HttpAgent;
}

function SidecarHarness({
  agent,
  initialMessages,
  onMessages,
}: {
  agent: HttpAgent | null;
  initialMessages: UIMessage[];
  onMessages: (messages: UIMessage[]) => void;
}): null {
  const snapshot = useMemo(
    () =>
      createEmptyThreadViewSnapshot({
        agent: "claudeCode",
        initialMessages,
      }),
    [initialMessages],
  );
  const projectEvent = useMemo(
    () => createThreadViewSidecarEventProjector(),
    [],
  );
  const viewModel = useThreadViewModel({
    agent,
    snapshot,
    projectEvent,
  });
  onMessages(viewModel.messages);
  return null;
}

function RoutedSidecarHarness({
  agent,
  initialMessages,
  onMessages,
  onStatusOrTerminalEvent,
  projectEvent: projectEventOverride,
}: {
  agent: HttpAgent | null;
  initialMessages: UIMessage[];
  onMessages: (messages: UIMessage[]) => void;
  onStatusOrTerminalEvent: () => void;
  projectEvent?: (
    event: ThreadViewEventForAgUi,
  ) => ThreadViewEventForAgUi | null;
}): null {
  const snapshot = useMemo(
    () =>
      createEmptyThreadViewSnapshot({
        agent: "claudeCode",
        initialMessages,
      }),
    [initialMessages],
  );
  const projectEvent = useMemo(
    () => createThreadViewSidecarEventProjector(),
    [],
  );
  const viewModel = useThreadViewModel({
    agent: null,
    snapshot,
  });
  useAgUiSidecarRouter({
    agent,
    dispatchThreadViewEvent: viewModel.dispatchThreadViewEvent,
    projectEvent: projectEventOverride ?? projectEvent,
    onStatusOrTerminalEvent,
  });
  onMessages(viewModel.messages);
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

describe("useThreadViewModel sidecar projection", () => {
  it("drops ordinary text deltas while keeping plan-like text and custom events", () => {
    const projector = createThreadViewSidecarEventProjector();

    expect(
      projector({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
      } as BaseEvent),
    ).toBeNull();
    expect(
      projector({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "ordinary token",
      } as BaseEvent),
    ).toBeNull();
    expect(
      projector({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "m1:thinking:0",
        delta: "thinking token",
      } as BaseEvent),
    ).toBeNull();
    expect(
      projector({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "<proposed_plan>",
      } as BaseEvent),
    ).toBeNull();
    expect(
      projector({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "ordinary token after plan",
      } as BaseEvent),
    ).toBeNull();
    expect(
      projector({
        type: EventType.CUSTOM,
        name: "artifact-reference",
      } as BaseEvent),
    ).toMatchObject({ type: EventType.CUSTOM });
  });

  it("runs as a product sidecar without forwarding transcript events", () => {
    const projector = createThreadViewSidecarEventProjector();

    expect(
      projector({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "<proposed_plan>",
      } as BaseEvent),
    ).toBeNull();
    expect(
      projector({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "Bash",
      } as BaseEvent),
    ).toBeNull();
    expect(
      projector({
        type: EventType.RUN_STARTED,
        runId: "run-1",
      } as BaseEvent),
    ).toMatchObject({ type: EventType.RUN_STARTED });
    expect(
      projector({
        type: EventType.CUSTOM,
        name: "artifact-reference",
      } as BaseEvent),
    ).toMatchObject({ type: EventType.CUSTOM });
  });

  it("updates sidecar metadata without folding transcript messages", () => {
    const initialSnapshot = createEmptyThreadViewSnapshot({
      agent: "claudeCode",
      initialMessages: [],
    });
    let state = createInitialThreadViewModelState(initialSnapshot);

    state = threadViewModelReducer(state, {
      type: "runtime.event",
      projectTranscript: false,
      event: {
        type: EventType.RUN_STARTED,
        runId: "run-1",
      } as BaseEvent,
    });
    state = threadViewModelReducer(state, {
      type: "ag-ui.event",
      projectTranscript: false,
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "agent-1",
        delta: "token",
      } as BaseEvent,
    });
    state = threadViewModelReducer(state, {
      type: "ag-ui.event",
      projectTranscript: false,
      event: {
        type: EventType.CUSTOM,
        name: "artifact-reference",
        value: {
          artifactId: "plan-1",
          artifactType: "plan",
          title: "Plan",
          status: "ready",
          uri: "artifact://plan-1",
        },
      } as BaseEvent,
    });

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.messages).toEqual([]);
    expect(viewModel.lifecycle).toMatchObject({
      runId: "run-1",
      runStarted: true,
      threadStatus: "working",
    });
    expect(viewModel.artifacts.descriptors).toHaveLength(1);
    expect(viewModel.artifacts.descriptors[0]).toMatchObject({
      id: "artifact:reference:plan-1",
      title: "Plan",
    });
  });

  it("does not let filtered text lifecycle block snapshot hydration", () => {
    const projector = createThreadViewSidecarEventProjector();
    const initialSnapshot = createEmptyThreadViewSnapshot({
      agent: "claudeCode",
      initialMessages: [],
    });
    let state = createInitialThreadViewModelState(initialSnapshot);
    const events: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "agent-1",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "agent-1",
        delta: "ordinary token",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "agent-1",
      } as BaseEvent,
    ];

    for (const event of events) {
      const projected = projector(event);
      if (projected) {
        state = threadViewModelReducer(state, {
          type: "ag-ui.event",
          event: projected,
        });
      }
    }

    expect(projectThreadViewModel(state).messages).toEqual([]);

    const hydratedMessage: UIMessage = {
      id: "agent-durable-1",
      role: "agent",
      agent: "claudeCode",
      parts: [{ type: "text", text: "durable text" }],
    };
    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: createEmptyThreadViewSnapshot({
        agent: "claudeCode",
        initialMessages: [hydratedMessage],
      }),
    });

    expect(projectThreadViewModel(state).messages).toEqual([hydratedMessage]);
  });

  it("drops tool events because assistant-ui owns transcript projection", () => {
    const projector = createThreadViewSidecarEventProjector();
    const initialSnapshot = createEmptyThreadViewSnapshot({
      agent: "claudeCode",
      initialMessages: [],
    });
    let state = createInitialThreadViewModelState(initialSnapshot);
    const events: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "agent-1",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "Bash",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: '{"command":"pwd"}',
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_END,
        toolCallId: "tool-1",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "tool-1",
        content: "/repo",
      } as BaseEvent,
    ];

    for (const event of events) {
      const projected = projector(event);
      if (projected) {
        state = threadViewModelReducer(state, {
          type: "ag-ui.event",
          event: projected,
        });
      }
    }

    expect(projectThreadViewModel(state).messages).toEqual([]);
  });

  it("routes run lifecycle events through the runtime event input", () => {
    expect(
      createThreadViewEventFromAgUiEvent({
        type: EventType.RUN_STARTED,
        runId: "run-1",
      } as BaseEvent),
    ).toMatchObject({ type: "runtime.event" });
    expect(
      createThreadViewEventFromAgUiEvent({
        type: EventType.RUN_FINISHED,
      } as BaseEvent),
    ).toMatchObject({ type: "runtime.event" });
    expect(
      createThreadViewEventFromAgUiEvent({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
      } as BaseEvent),
    ).toMatchObject({ type: "ag-ui.event" });
  });

  it("keeps sidecar transcript empty across ordinary streamed text deltas", () => {
    const agent = createFakeAgent();
    const seen: UIMessage[][] = [];
    const initial: UIMessage[] = [
      { id: "user-0", role: "user", parts: [{ type: "text", text: "hi" }] },
    ];

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        createElement(SidecarHarness, {
          agent: asHttpAgent(agent),
          initialMessages: initial,
          onMessages: (messages) => seen.push(messages),
        }),
      );
    });
    const beforeStreaming = seen[seen.length - 1]!;
    expect(beforeStreaming).toEqual([]);

    act(() => {
      agent.emit({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "agent-1",
        role: "assistant",
      } as BaseEvent);
      for (let index = 0; index < 100; index += 1) {
        agent.emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "agent-1",
          delta: " token",
        } as BaseEvent);
      }
    });

    const last = seen[seen.length - 1]!;
    expect(last).toBe(beforeStreaming);
  });

  it("records client event receipt spans for native AG-UI events", () => {
    const agent = createFakeAgent();
    const onMessages = vi.fn();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        createElement(SidecarHarness, {
          agent: asHttpAgent(agent),
          initialMessages: [],
          onMessages,
        }),
      );
    });
    act(() => {
      agent.emit({
        type: EventType.RUN_STARTED,
        runId: "run-1",
        threadId: "thread-1",
      } as BaseEvent);
    });

    expect(recordAgentTraceSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "run-1",
        name: "client.agui.event.received",
        attributes: expect.objectContaining({
          eventType: EventType.RUN_STARTED,
        }),
      }),
    );
  });

  it("routes sidecar state and status invalidation through one subscription", () => {
    const agent = createFakeAgent();
    const onMessages = vi.fn();
    const onStatusOrTerminalEvent = vi.fn();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        createElement(RoutedSidecarHarness, {
          agent: asHttpAgent(agent),
          initialMessages: [],
          onMessages,
          onStatusOrTerminalEvent,
        }),
      );
    });

    expect(agent.subscribers).toHaveLength(1);

    act(() => {
      agent.emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "agent-1",
        delta: "ordinary token",
      } as BaseEvent);
      agent.emit({
        type: EventType.CUSTOM,
        name: "thread.status_changed",
        value: { status: "working" },
      } as BaseEvent);
      agent.emit({
        type: EventType.RUN_FINISHED,
        runId: "run-1",
      } as BaseEvent);
    });

    expect(onStatusOrTerminalEvent).toHaveBeenCalledTimes(2);
    expect(onMessages).toHaveBeenLastCalledWith([]);
    expect(recordAgentTraceSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "agent-1",
        name: "client.agui.event.received",
        attributes: expect.objectContaining({
          eventType: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "agent-1",
        }),
      }),
    );
  });

  it("invalidates status events before sidecar projection can filter them", () => {
    const agent = createFakeAgent();
    const onMessages = vi.fn();
    const onStatusOrTerminalEvent = vi.fn();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        createElement(RoutedSidecarHarness, {
          agent: asHttpAgent(agent),
          initialMessages: [],
          onMessages,
          onStatusOrTerminalEvent,
          projectEvent: () => null,
        }),
      );
    });

    act(() => {
      agent.emit({
        type: EventType.CUSTOM,
        name: "thread.status_changed",
        value: { status: "working" },
      } as BaseEvent);
    });

    expect(onStatusOrTerminalEvent).toHaveBeenCalledOnce();
    expect(onMessages).toHaveBeenLastCalledWith([]);
  });

  it("can skip legacy transcript projection for runtime-owned rendering", () => {
    const seen: UIMessage[][] = [];
    const initial: UIMessage[] = [
      { id: "user-0", role: "user", parts: [{ type: "text", text: "hi" }] },
    ];

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        createElement(SidecarHarness, {
          agent: null,
          initialMessages: initial,
          onMessages: (messages) => seen.push(messages),
        }),
      );
    });

    expect(seen.at(-1)).toEqual([]);
  });

  it("unsubscribes from the agent on unmount", () => {
    const agent = createFakeAgent();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        createElement(SidecarHarness, {
          agent: asHttpAgent(agent),
          initialMessages: [],
          onMessages: () => {},
        }),
      );
    });
    expect(agent.subscribers).toHaveLength(1);

    act(() => {
      root?.unmount();
    });
    root = null;
    expect(agent.subscribers).toHaveLength(0);
    expect(agent.unsubscribeCount).toBe(1);
  });
});
