/* @vitest-environment jsdom */

import type { HttpAgent } from "@ag-ui/client";
import {
  EventType,
  type BaseEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
} from "@ag-ui/core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgUiRunEvents } from "./use-ag-ui-run-events";

/**
 * Minimal fake of `HttpAgent.subscribe` mirroring the helper used by
 * `use-ag-ui-custom-events.test.tsx` so both hooks exercise the same
 * subscription lifecycle contract.
 */
interface FakeAgent {
  subscribe: (subscriber: {
    onEvent?: (params: { event: BaseEvent }) => void;
  }) => { unsubscribe: () => void };
  emit: (event: BaseEvent) => void;
  subscribeCalls: number;
  unsubscribeCalls: number;
  subscribers: Array<(params: { event: BaseEvent }) => void>;
}

function createFakeAgent(): FakeAgent {
  const fake: FakeAgent = {
    subscribeCalls: 0,
    unsubscribeCalls: 0,
    subscribers: [],
    subscribe: (subscriber) => {
      fake.subscribeCalls += 1;
      const handler = subscriber.onEvent;
      if (handler) fake.subscribers.push(handler);
      return {
        unsubscribe: () => {
          fake.unsubscribeCalls += 1;
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

function makeRunFinished(): RunFinishedEvent {
  return {
    type: EventType.RUN_FINISHED,
    threadId: "thread-1",
    runId: "run-1",
  } as RunFinishedEvent;
}

function makeRunError(): RunErrorEvent {
  return {
    type: EventType.RUN_ERROR,
    message: "boom",
  } as RunErrorEvent;
}

function Harness({
  agent,
  onRunFinished,
  onRunError,
}: {
  agent: FakeAgent | null;
  onRunFinished?: (event: RunFinishedEvent) => void;
  onRunError?: (event: RunErrorEvent) => void;
}): null {
  useAgUiRunEvents(asHttpAgent(agent), onRunFinished, onRunError);
  return null;
}

async function renderHarness(props: {
  agent: FakeAgent | null;
  onRunFinished?: (event: RunFinishedEvent) => void;
  onRunError?: (event: RunErrorEvent) => void;
}): Promise<{ root: Root; unmount: () => void }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Harness, props));
  });
  return {
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("useAgUiRunEvents", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it("fires onRunFinished when a RUN_FINISHED event is emitted", async () => {
    const fake = createFakeAgent();
    const onRunFinished = vi.fn();
    const onRunError = vi.fn();
    const harness = await renderHarness({
      agent: fake,
      onRunFinished,
      onRunError,
    });
    cleanups.push(harness.unmount);

    const ev = makeRunFinished();
    await act(async () => {
      fake.emit(ev);
    });

    expect(onRunFinished).toHaveBeenCalledTimes(1);
    expect(onRunFinished).toHaveBeenCalledWith(ev);
    expect(onRunError).not.toHaveBeenCalled();
  });

  it("fires onRunError when a RUN_ERROR event is emitted", async () => {
    const fake = createFakeAgent();
    const onRunFinished = vi.fn();
    const onRunError = vi.fn();
    const harness = await renderHarness({
      agent: fake,
      onRunFinished,
      onRunError,
    });
    cleanups.push(harness.unmount);

    const ev = makeRunError();
    await act(async () => {
      fake.emit(ev);
    });

    expect(onRunError).toHaveBeenCalledTimes(1);
    expect(onRunError).toHaveBeenCalledWith(ev);
    expect(onRunFinished).not.toHaveBeenCalled();
  });

  it("ignores events that are neither RUN_FINISHED nor RUN_ERROR", async () => {
    const fake = createFakeAgent();
    const onRunFinished = vi.fn();
    const onRunError = vi.fn();
    const harness = await renderHarness({
      agent: fake,
      onRunFinished,
      onRunError,
    });
    cleanups.push(harness.unmount);

    const nonMatching: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m",
        role: "assistant",
      } as BaseEvent,
      { type: EventType.CUSTOM, name: "anything", value: 1 } as BaseEvent,
    ];
    await act(async () => {
      for (const ev of nonMatching) fake.emit(ev);
    });

    expect(onRunFinished).not.toHaveBeenCalled();
    expect(onRunError).not.toHaveBeenCalled();
  });
});
