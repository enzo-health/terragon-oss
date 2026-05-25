/* @vitest-environment jsdom */

import type { HttpAgent } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadViewEvent } from "./thread-view-model/types";
import { useProductSidecars } from "./use-product-sidecars";

type FakeAgent = {
  subscribe: (subscriber: {
    onEvent?: (params: { event: BaseEvent }) => void;
  }) => { unsubscribe: () => void };
  emit: (event: BaseEvent) => void;
  subscribers: Array<(params: { event: BaseEvent }) => void>;
};

function createFakeAgent(): FakeAgent {
  const fake: FakeAgent = {
    subscribers: [],
    subscribe: (subscriber) => {
      const handler = subscriber.onEvent;
      if (handler) {
        fake.subscribers.push(handler);
      }
      return {
        unsubscribe: () => {
          if (!handler) {
            return;
          }
          const index = fake.subscribers.indexOf(handler);
          if (index >= 0) {
            fake.subscribers.splice(index, 1);
          }
        },
      };
    },
    emit: (event) => {
      for (const subscriber of [...fake.subscribers]) {
        subscriber({ event });
      }
    },
  };
  return fake;
}

function asHttpAgent(agent: FakeAgent): HttpAgent {
  return agent as unknown as HttpAgent;
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

function Harness({
  agent,
  dispatchThreadViewEvent,
}: {
  agent: HttpAgent | null;
  dispatchThreadViewEvent: (event: ThreadViewEvent) => void;
}): null {
  useProductSidecars({
    agent,
    threadId: "thread-1",
    threadChatId: "chat-1",
    dispatchThreadViewEvent,
  });
  return null;
}

async function flushScheduledInvalidations(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useProductSidecars", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  it("routes product sidecars without projecting transcript events", async () => {
    const agent = createFakeAgent();
    const dispatchThreadViewEvent = vi.fn<(event: ThreadViewEvent) => void>();
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        createElement(QueryClientProvider, {
          client: queryClient,
          children: createElement(Harness, {
            agent: asHttpAgent(agent),
            dispatchThreadViewEvent,
          }),
        }),
      );
    });

    expect(agent.subscribers).toHaveLength(1);

    act(() => {
      agent.emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-1",
        delta: "runtime transcript token",
      } as BaseEvent);
      agent.emit({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "Bash",
      } as BaseEvent);
      agent.emit({
        type: EventType.CUSTOM,
        name: "terragon.data-part",
        value: {
          messageId: "assistant-1",
          partIndex: 0,
          name: "terragon.terminal",
          data: { type: "terminal", chunks: [] },
        },
      } as BaseEvent);
    });

    expect(dispatchThreadViewEvent).not.toHaveBeenCalled();

    act(() => {
      agent.emit({
        type: EventType.CUSTOM,
        name: "artifact-reference",
        value: {
          artifactId: "plan-1",
          artifactType: "plan",
          title: "Plan",
          status: "ready",
        },
      } as BaseEvent);
      agent.emit({
        type: EventType.CUSTOM,
        name: "thread.status_changed",
        value: { status: "working" },
      } as BaseEvent);
    });
    await flushScheduledInvalidations();

    expect(dispatchThreadViewEvent).toHaveBeenCalledWith({
      type: "ag-ui.event",
      projectTranscript: false,
      event: expect.objectContaining({
        type: EventType.CUSTOM,
        name: "artifact-reference",
      }),
    });
    expect(dispatchThreadViewEvent).toHaveBeenCalledWith({
      type: "ag-ui.event",
      projectTranscript: false,
      event: expect.objectContaining({
        type: EventType.CUSTOM,
        name: "thread.status_changed",
      }),
    });
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("allows meta and native runtime sidecars", () => {
    const agent = createFakeAgent();
    const dispatchThreadViewEvent = vi.fn<(event: ThreadViewEvent) => void>();
    const queryClient = createQueryClient();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        createElement(QueryClientProvider, {
          client: queryClient,
          children: createElement(Harness, {
            agent: asHttpAgent(agent),
            dispatchThreadViewEvent,
          }),
        }),
      );
    });

    act(() => {
      agent.emit({
        type: EventType.CUSTOM,
        name: "thread.token_usage_updated",
        value: {
          kind: "thread.token_usage_updated",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 2,
          },
        },
      } as BaseEvent);
      agent.emit({
        type: EventType.STATE_SNAPSHOT,
        snapshot: { sandbox: "ready" },
      } as BaseEvent);
      agent.emit({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
        activityType: "status",
        content: { text: "running" },
      } as BaseEvent);
    });

    expect(dispatchThreadViewEvent).toHaveBeenCalledWith({
      type: "ag-ui.event",
      projectTranscript: false,
      event: expect.objectContaining({
        type: EventType.CUSTOM,
        name: "thread.token_usage_updated",
      }),
    });
    expect(dispatchThreadViewEvent).toHaveBeenCalledWith({
      type: "ag-ui.event",
      projectTranscript: false,
      event: expect.objectContaining({
        type: EventType.STATE_SNAPSHOT,
      }),
    });
    expect(dispatchThreadViewEvent).toHaveBeenCalledWith({
      type: "ag-ui.event",
      projectTranscript: false,
      event: expect.objectContaining({
        type: EventType.ACTIVITY_SNAPSHOT,
      }),
    });
  });
});
