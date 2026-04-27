/* @vitest-environment jsdom */

import type { HttpAgent } from "@ag-ui/client";
import {
  EventType,
  type BaseEvent,
  type CustomEvent as AgUiCustomEvent,
  type RunErrorEvent,
  type RunFinishedEvent,
} from "@ag-ui/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { AgUiAgentProvider } from "@/components/chat/ag-ui-agent-context";
import { threadQueryKeys } from "@/queries/thread-queries";
import { useAgUiQueryInvalidator } from "./use-ag-ui-query-invalidator";

// Reuse the subscribe lifecycle fake from the run/custom event tests.
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
  threadChatId,
}: {
  threadId: string;
  threadChatId: string | null;
}): null {
  useAgUiQueryInvalidator({ threadId, threadChatId });
  return null;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function makeCustomEvent(name: string): AgUiCustomEvent {
  return {
    type: EventType.CUSTOM,
    name,
    value: null,
  } as AgUiCustomEvent;
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

describe("useAgUiQueryInvalidator", () => {
  let container: HTMLDivElement | null = null;
  let invalidateSpy: MockInstance | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    invalidateSpy?.mockRestore();
    invalidateSpy = null;
    container?.remove();
    container = null;
  });

  function renderWith(
    agent: FakeAgent,
    threadId: string,
    threadChatId: string | null,
  ): { queryClient: QueryClient; unmount: () => void } {
    const queryClient = createQueryClient();
    invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const root = createRoot(container!);
    act(() => {
      root.render(
        createElement(QueryClientProvider, {
          client: queryClient,
          children: createElement(AgUiAgentProvider, {
            agent: asHttpAgent(agent),
            children: createElement(Harness, { threadId, threadChatId }),
          }),
        }),
      );
    });
    return {
      queryClient,
      unmount: () => {
        act(() => {
          root.unmount();
        });
      },
    };
  }

  it("invalidates shell + list + chat on thread.status_changed CUSTOM events", async () => {
    const fake = createFakeAgent();
    const { unmount } = renderWith(fake, "thread-1", "chat-1");

    await act(async () => {
      fake.emit(makeCustomEvent("thread.status_changed"));
    });

    expect(invalidateSpy).toHaveBeenCalledTimes(3);
    const calls = invalidateSpy!.mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual({
      queryKey: threadQueryKeys.shell("thread-1"),
    });
    expect(calls).toContainEqual({
      queryKey: threadQueryKeys.list(null),
    });
    expect(calls).toContainEqual({
      queryKey: threadQueryKeys.chat("thread-1", "chat-1"),
    });

    // Non-matching CUSTOM events must NOT invalidate.
    invalidateSpy!.mockClear();
    await act(async () => {
      fake.emit(makeCustomEvent("thread.token_usage_updated"));
    });
    expect(invalidateSpy).not.toHaveBeenCalled();

    unmount();
  });

  it("invalidates shell + list + chat on RUN_FINISHED and RUN_ERROR events", async () => {
    const fake = createFakeAgent();
    const { unmount } = renderWith(fake, "thread-1", "chat-1");

    await act(async () => {
      fake.emit(makeRunFinished());
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(3);
    let calls = invalidateSpy!.mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual({
      queryKey: threadQueryKeys.shell("thread-1"),
    });
    expect(calls).toContainEqual({
      queryKey: threadQueryKeys.list(null),
    });
    expect(calls).toContainEqual({
      queryKey: threadQueryKeys.chat("thread-1", "chat-1"),
    });

    invalidateSpy!.mockClear();
    await act(async () => {
      fake.emit(makeRunError());
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(3);
    calls = invalidateSpy!.mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual({
      queryKey: threadQueryKeys.shell("thread-1"),
    });
    expect(calls).toContainEqual({
      queryKey: threadQueryKeys.list(null),
    });
    expect(calls).toContainEqual({
      queryKey: threadQueryKeys.chat("thread-1", "chat-1"),
    });

    unmount();
  });

  it("skips chat invalidation when threadChatId is null but still refreshes shell + list", async () => {
    const fake = createFakeAgent();
    const { unmount } = renderWith(fake, "thread-1", null);

    await act(async () => {
      fake.emit(makeRunFinished());
    });

    expect(invalidateSpy).toHaveBeenCalledTimes(2);
    const calls = invalidateSpy!.mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual({
      queryKey: threadQueryKeys.shell("thread-1"),
    });
    expect(calls).toContainEqual({
      queryKey: threadQueryKeys.list(null),
    });
    expect(calls).not.toContainEqual(
      expect.objectContaining({
        queryKey: expect.arrayContaining(["chat"]),
      }),
    );

    unmount();
  });

  it("heartbeats invalidations while the thread is believed live", async () => {
    vi.useFakeTimers();
    const fake = createFakeAgent();
    const { queryClient, unmount } = renderWith(fake, "thread-1", "chat-1");

    try {
      invalidateSpy!.mockClear();
      queryClient.setQueryData(threadQueryKeys.chat("thread-1", "chat-1"), {
        status: "working",
      });

      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });

      expect(invalidateSpy).toHaveBeenCalled();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("does not heartbeat invalidations once the thread is terminal", async () => {
    vi.useFakeTimers();
    const fake = createFakeAgent();
    const { queryClient, unmount } = renderWith(fake, "thread-1", "chat-1");

    try {
      invalidateSpy!.mockClear();
      queryClient.setQueryData(threadQueryKeys.chat("thread-1", "chat-1"), {
        status: "complete",
      });

      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });

      expect(invalidateSpy).not.toHaveBeenCalled();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });
});
