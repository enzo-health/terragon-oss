/* @vitest-environment jsdom */

import type { HttpAgent } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { UIMessage } from "@terragon/shared";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useAgUiMessages } from "./use-ag-ui-messages";

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

function Harness({
  agent,
  initialMessages,
  onMessages,
}: {
  agent: HttpAgent | null;
  initialMessages: UIMessage[];
  onMessages: (messages: UIMessage[]) => void;
}): null {
  const messages = useAgUiMessages({
    agent,
    agentKind: "claudeCode",
    initialMessages,
  });
  onMessages(messages);
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

describe("useAgUiMessages", () => {
  it("seeds with initialMessages and appends assistant message on TEXT_MESSAGE_START/CONTENT", () => {
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
        createElement(Harness, {
          agent: asHttpAgent(agent),
          initialMessages: initial,
          onMessages: (m) => seen.push(m),
        }),
      );
    });

    // Initial render: only the seed message.
    expect(seen[seen.length - 1]).toEqual(initial);

    act(() => {
      agent.emit({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "agent-1",
        role: "assistant",
      } as BaseEvent);
      agent.emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "agent-1",
        delta: "streaming",
      } as BaseEvent);
    });

    const last = seen[seen.length - 1]!;
    expect(last).toHaveLength(2);
    expect(last[0]!.id).toBe("user-0");
    expect(last[1]).toMatchObject({
      id: "agent-1",
      role: "agent",
    });
    const parts = (last[1] as { parts: Array<{ text?: string }> }).parts;
    expect(parts[0]!.text).toBe("streaming");
  });

  it("unsubscribes from the agent on unmount", () => {
    const agent = createFakeAgent();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        createElement(Harness, {
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

  it("is a no-op when agent is null", () => {
    const seen: UIMessage[][] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        createElement(Harness, {
          agent: null,
          initialMessages: [],
          onMessages: (m) => seen.push(m),
        }),
      );
    });

    expect(seen[seen.length - 1]).toEqual([]);
  });
});
