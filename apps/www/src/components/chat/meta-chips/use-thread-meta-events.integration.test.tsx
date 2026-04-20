/* @vitest-environment jsdom */

import type { HttpAgent } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgUiAgentProvider } from "../ag-ui-agent-context";
import {
  useThreadMetaEvents,
  type ThreadMetaSnapshot,
} from "./use-thread-meta-events";

/**
 * Integration test: guards against drift between `THREAD_META_EVENT_KINDS`
 * and the reducer's switch cases. Mounts the real hook under a fake
 * `AgUiAgentProvider` and pipes CUSTOM events through the subscribed
 * handler.
 */

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

function asHttpAgent(fake: FakeAgent): HttpAgent {
  return fake as unknown as HttpAgent;
}

function Harness({
  threadId,
  onSnapshot,
}: {
  threadId: string;
  onSnapshot: (snapshot: ThreadMetaSnapshot) => void;
}): null {
  const { snapshot } = useThreadMetaEvents(threadId);
  onSnapshot(snapshot);
  return null;
}

function mount(agent: FakeAgent): {
  snapshots: ThreadMetaSnapshot[];
  root: Root;
  container: HTMLDivElement;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const snapshots: ThreadMetaSnapshot[] = [];
  act(() => {
    root.render(
      createElement(AgUiAgentProvider, {
        agent: asHttpAgent(agent),
        children: createElement(Harness, {
          threadId: "t1",
          onSnapshot: (s) => snapshots.push(s),
        }),
      }),
    );
  });
  return {
    snapshots,
    root,
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function latest(snapshots: ThreadMetaSnapshot[]): ThreadMetaSnapshot {
  const s = snapshots[snapshots.length - 1];
  if (!s) throw new Error("no snapshots captured");
  return s;
}

describe("useThreadMetaEvents (AG-UI integration)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it("happy path: a matching CUSTOM event updates the snapshot", () => {
    const agent = createFakeAgent();
    const { snapshots, unmount } = mount(agent);
    cleanups.push(unmount);

    // Initial snapshot: everything null/empty.
    expect(latest(snapshots).tokenUsage).toBeNull();

    act(() => {
      agent.emit({
        type: EventType.CUSTOM,
        name: "thread.token_usage_updated",
        value: {
          kind: "thread.token_usage_updated",
          threadId: "t1",
          usage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            outputTokens: 50,
          },
        },
      } as BaseEvent);
    });

    expect(latest(snapshots).tokenUsage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
    });
  });

  it("filter: unknown CUSTOM names do not mutate the snapshot", () => {
    const agent = createFakeAgent();
    const { snapshots, unmount } = mount(agent);
    cleanups.push(unmount);

    const snapshotBefore = latest(snapshots);

    act(() => {
      agent.emit({
        type: EventType.CUSTOM,
        name: "some.future_event_kind",
        value: {
          kind: "some.future_event_kind",
          threadId: "t1",
          arbitraryPayload: { foo: "bar" },
        },
      } as BaseEvent);
    });

    // Reference equality — no dispatch means no new snapshot value.
    expect(latest(snapshots)).toBe(snapshotBefore);
    expect(latest(snapshots).tokenUsage).toBeNull();
    expect(latest(snapshots).rateLimits).toBeNull();
  });
});
