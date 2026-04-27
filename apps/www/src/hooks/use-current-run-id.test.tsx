/* @vitest-environment jsdom */

import type { HttpAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunStartedEvent } from "@ag-ui/core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { selectScopedRunId, useCurrentRunId } from "./use-current-run-id";

interface FakeAgent {
  subscribe: (subscriber: {
    onEvent?: (params: { event: BaseEvent }) => void;
  }) => { unsubscribe: () => void };
  emit: (event: BaseEvent) => void;
  subscribers: Array<(params: { event: BaseEvent }) => void>;
}

function createFakeAgent(): FakeAgent {
  const fake: FakeAgent = {
    subscribers: [],
    subscribe: (subscriber) => {
      const handler = subscriber.onEvent;
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
    emit: (event) => {
      for (const sub of [...fake.subscribers]) sub({ event });
    },
  };
  return fake;
}

function asHttpAgent(fake: FakeAgent | null): HttpAgent | null {
  return fake as unknown as HttpAgent | null;
}

function makeRunStarted(runId: string): RunStartedEvent {
  return {
    type: EventType.RUN_STARTED,
    threadId: "thread-1",
    runId,
    timestamp: Date.now(),
  } as RunStartedEvent;
}

function Harness({
  agent,
  captured,
}: {
  agent: FakeAgent | null;
  captured: { value: string | null };
}) {
  captured.value = useCurrentRunId(asHttpAgent(agent));
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(ui: React.ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
});

describe("useCurrentRunId", () => {
  it("returns null before any RUN_STARTED is observed", () => {
    const agent = createFakeAgent();
    const captured = { value: "initial" as string | null };
    mount(createElement(Harness, { agent, captured }));
    expect(captured.value).toBeNull();
  });

  it("captures runId from the first RUN_STARTED event", () => {
    const agent = createFakeAgent();
    const captured = { value: null as string | null };
    mount(createElement(Harness, { agent, captured }));

    act(() => {
      agent.emit(makeRunStarted("run-abc"));
    });
    expect(captured.value).toBe("run-abc");
  });

  it("overwrites with the most recent RUN_STARTED runId", () => {
    const agent = createFakeAgent();
    const captured = { value: null as string | null };
    mount(createElement(Harness, { agent, captured }));

    act(() => {
      agent.emit(makeRunStarted("run-first"));
    });
    expect(captured.value).toBe("run-first");
    act(() => {
      agent.emit(makeRunStarted("run-second"));
    });
    expect(captured.value).toBe("run-second");
  });

  it("clears the captured runId when the agent changes", () => {
    const firstAgent = createFakeAgent();
    const secondAgent = createFakeAgent();
    const captured = { value: null as string | null };
    mount(createElement(Harness, { agent: firstAgent, captured }));

    act(() => {
      firstAgent.emit(makeRunStarted("run-first"));
    });
    expect(captured.value).toBe("run-first");

    act(() => {
      root!.render(createElement(Harness, { agent: secondAgent, captured }));
    });
    expect(captured.value).toBeNull();

    act(() => {
      firstAgent.emit(makeRunStarted("run-stale"));
      secondAgent.emit(makeRunStarted("run-second"));
    });
    expect(captured.value).toBe("run-second");
  });

  it("ignores non-RUN_STARTED events", () => {
    const agent = createFakeAgent();
    const captured = { value: null as string | null };
    mount(createElement(Harness, { agent, captured }));

    act(() => {
      agent.emit({ type: EventType.TEXT_MESSAGE_START } as BaseEvent);
      agent.emit({ type: EventType.RUN_FINISHED } as BaseEvent);
    });
    expect(captured.value).toBeNull();
  });

  it("returns null when agent is null", () => {
    const captured = { value: "initial" as string | null };
    mount(createElement(Harness, { agent: null, captured }));
    expect(captured.value).toBeNull();
  });
});

describe("selectScopedRunId", () => {
  it("returns null when the captured run belongs to another thread chat", () => {
    const state = {
      threadId: "thread-1",
      threadChatId: "chat-1",
      runId: "run-1",
    };

    expect(
      selectScopedRunId({
        state,
        threadId: "thread-1",
        threadChatId: "chat-2",
      }),
    ).toBeNull();
  });

  it("returns the captured run only for the matching thread chat", () => {
    const state = {
      threadId: "thread-1",
      threadChatId: "chat-1",
      runId: "run-1",
    };

    expect(
      selectScopedRunId({
        state,
        threadId: "thread-1",
        threadChatId: "chat-1",
      }),
    ).toBe("run-1");
  });
});
