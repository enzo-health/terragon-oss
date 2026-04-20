/* @vitest-environment jsdom */

import type { HttpAgent } from "@ag-ui/client";
import {
  EventType,
  type BaseEvent,
  type CustomEvent as AgUiCustomEvent,
} from "@ag-ui/core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgUiCustomEvents } from "./use-ag-ui-custom-events";

/**
 * Minimal fake of `HttpAgent.subscribe` that lets tests push events and
 * assert subscription lifecycle.
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

function makeCustomEvent(name: string, value: unknown): AgUiCustomEvent {
  return {
    type: EventType.CUSTOM,
    name,
    value,
  } as AgUiCustomEvent;
}

function Harness({
  agent,
  filter,
  onEvent,
}: {
  agent: FakeAgent | null;
  filter: (name: string) => boolean;
  onEvent: (event: AgUiCustomEvent) => void;
}): null {
  useAgUiCustomEvents(asHttpAgent(agent), filter, onEvent);
  return null;
}

async function renderHarness(props: {
  agent: FakeAgent | null;
  filter: (name: string) => boolean;
  onEvent: (event: AgUiCustomEvent) => void;
}): Promise<{
  root: Root;
  container: HTMLDivElement;
  rerender: (next: Partial<typeof props>) => Promise<void>;
  unmount: () => void;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let current = { ...props };
  await act(async () => {
    root.render(createElement(Harness, current));
  });
  return {
    root,
    container,
    rerender: async (next) => {
      current = { ...current, ...next };
      await act(async () => {
        root.render(createElement(Harness, current));
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("useAgUiCustomEvents", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it("is a no-op when agent is null (no subscribe attempt)", async () => {
    const filter = vi.fn(() => true);
    const onEvent = vi.fn();
    const harness = await renderHarness({ agent: null, filter, onEvent });
    cleanups.push(harness.unmount);
    expect(filter).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("subscribes on mount and unsubscribes on unmount", async () => {
    const fake = createFakeAgent();
    const filter = vi.fn(() => true);
    const onEvent = vi.fn();
    const harness = await renderHarness({ agent: fake, filter, onEvent });

    expect(fake.subscribeCalls).toBe(1);
    expect(fake.unsubscribeCalls).toBe(0);

    harness.unmount();
    expect(fake.unsubscribeCalls).toBe(1);
    expect(fake.subscribers.length).toBe(0);
  });

  it("invokes filter for each CUSTOM event and skips non-CUSTOM", async () => {
    const fake = createFakeAgent();
    const filter = vi.fn(
      (name: string) => name === "thread.token_usage_updated",
    );
    const onEvent = vi.fn();
    const harness = await renderHarness({ agent: fake, filter, onEvent });
    cleanups.push(harness.unmount);

    const customMatch = makeCustomEvent("thread.token_usage_updated", { x: 1 });
    const customNoMatch = makeCustomEvent("other.kind", { y: 2 });
    const nonCustom: BaseEvent = {
      type: EventType.RUN_STARTED,
      threadId: "t",
      runId: "r",
    } as BaseEvent;

    await act(async () => {
      fake.emit(customMatch);
      fake.emit(customNoMatch);
      fake.emit(nonCustom);
    });

    // filter called only for CUSTOM events
    expect(filter).toHaveBeenCalledTimes(2);
    expect(filter).toHaveBeenNthCalledWith(1, "thread.token_usage_updated");
    expect(filter).toHaveBeenNthCalledWith(2, "other.kind");

    // onEvent called only for the matching CUSTOM event
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(customMatch);
  });

  it("re-subscribes when agent identity changes", async () => {
    const a = createFakeAgent();
    const b = createFakeAgent();
    const filter = () => true;
    const onEvent = vi.fn();
    const harness = await renderHarness({ agent: a, filter, onEvent });
    cleanups.push(harness.unmount);

    expect(a.subscribeCalls).toBe(1);
    expect(b.subscribeCalls).toBe(0);

    await harness.rerender({ agent: b });
    expect(a.unsubscribeCalls).toBe(1);
    expect(b.subscribeCalls).toBe(1);

    // Events to the old agent are ignored (no listeners)
    await act(async () => {
      a.emit(makeCustomEvent("x", 1));
    });
    expect(onEvent).not.toHaveBeenCalled();

    // Events to the new agent are delivered
    await act(async () => {
      b.emit(makeCustomEvent("x", 2));
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-subscribe when filter or onEvent identity changes", async () => {
    const fake = createFakeAgent();
    const filter1 = vi.fn(() => true);
    const onEvent1 = vi.fn();
    const harness = await renderHarness({
      agent: fake,
      filter: filter1,
      onEvent: onEvent1,
    });
    cleanups.push(harness.unmount);
    expect(fake.subscribeCalls).toBe(1);

    const filter2 = vi.fn(() => true);
    const onEvent2 = vi.fn();
    await harness.rerender({ filter: filter2, onEvent: onEvent2 });

    // Still only one subscription, no unsubscribe yet.
    expect(fake.subscribeCalls).toBe(1);
    expect(fake.unsubscribeCalls).toBe(0);

    // Emitting now should hit the NEW callbacks (ref tracking).
    await act(async () => {
      fake.emit(makeCustomEvent("hello", 1));
    });
    expect(filter1).not.toHaveBeenCalled();
    expect(onEvent1).not.toHaveBeenCalled();
    expect(filter2).toHaveBeenCalledWith("hello");
    expect(onEvent2).toHaveBeenCalledTimes(1);
  });
});
