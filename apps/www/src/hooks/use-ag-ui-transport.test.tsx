/* @vitest-environment jsdom */

import type { Message, State } from "@ag-ui/core";
import { Provider, useSetAtom } from "jotai";
import type { ReactElement } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bearerTokenAtom } from "@/atoms/user";
import { useAgUiTransport } from "./use-ag-ui-transport";

// Mock @ag-ui/client so we can assert constructor args without pulling in
// the full RxJS / fetch runtime.
const httpAgentInstances: Array<{ config: unknown; id: number }> = [];
let nextHttpAgentId = 0;

vi.mock("@ag-ui/client", () => {
  class MockHttpAgent {
    url: string;
    headers: Record<string, string>;
    threadId?: string;
    initialMessages?: Message[];
    initialState?: State;
    __mockId: number;

    constructor(config: {
      url: string;
      headers?: Record<string, string>;
      threadId?: string;
      initialMessages?: Message[];
      initialState?: State;
    }) {
      this.url = config.url;
      this.headers = config.headers ?? {};
      this.threadId = config.threadId;
      this.initialMessages = config.initialMessages;
      this.initialState = config.initialState;
      this.__mockId = nextHttpAgentId++;
      httpAgentInstances.push({ config, id: this.__mockId });
    }
  }
  return { HttpAgent: MockHttpAgent };
});

type TransportArgs = Parameters<typeof useAgUiTransport>[0];

interface CapturedAgent {
  url: string;
  headers: Record<string, string>;
  threadId?: string;
  initialMessages?: Message[];
  initialState?: State;
  __mockId: number;
}

function Harness({
  args,
  onAgent,
  bearerToken,
}: {
  args: TransportArgs;
  onAgent: (agent: CapturedAgent) => void;
  bearerToken: string | null;
}): ReactElement {
  return createElement(TokenSetter, { bearerToken, args, onAgent });
}

function TokenSetter({
  args,
  onAgent,
  bearerToken,
}: {
  args: TransportArgs;
  onAgent: (agent: CapturedAgent) => void;
  bearerToken: string | null;
}): ReactElement | null {
  const setBearer = useSetAtom(bearerTokenAtom);
  // Set the atom in-render so the subsequent hook reads the intended
  // token on its FIRST render. Jotai supports in-render setters and
  // will not trigger infinite re-renders if the value is stable.
  setBearer(bearerToken);
  return createElement(Inner, { args, onAgent });
}

function Inner({
  args,
  onAgent,
}: {
  args: TransportArgs;
  onAgent: (agent: CapturedAgent) => void;
}): null {
  const agent = useAgUiTransport(args);
  useEffect(() => {
    onAgent(agent as unknown as CapturedAgent);
  }, [agent, onAgent]);
  return null;
}

async function renderHarness({
  args,
  bearerToken,
}: {
  args: TransportArgs;
  bearerToken: string | null;
}): Promise<{
  container: HTMLDivElement;
  root: Root;
  captured: CapturedAgent[];
  rerender: (next: {
    args: TransportArgs;
    bearerToken: string | null;
  }) => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const captured: CapturedAgent[] = [];
  const onAgent = (agent: CapturedAgent) => {
    captured.push(agent);
  };

  await act(async () => {
    root.render(
      createElement(
        Provider,
        null,
        createElement(Harness, { args, onAgent, bearerToken }),
      ),
    );
  });

  const rerender = async (next: {
    args: TransportArgs;
    bearerToken: string | null;
  }) => {
    await act(async () => {
      root.render(
        createElement(
          Provider,
          null,
          createElement(Harness, {
            args: next.args,
            onAgent,
            bearerToken: next.bearerToken,
          }),
        ),
      );
    });
  };

  return { container, root, captured, rerender };
}

describe("useAgUiTransport", () => {
  afterEach(() => {
    httpAgentInstances.length = 0;
    nextHttpAgentId = 0;
    vi.clearAllMocks();
  });

  it("returns an HttpAgent instance", async () => {
    const { captured, root, container } = await renderHarness({
      args: { threadId: "t1", threadChatId: "c1", fromSeq: 0 },
      bearerToken: "bearer-123",
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).toBeDefined();
    expect(typeof captured[0]!.__mockId).toBe("number");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("uses URL /api/ag-ui/{threadId}?threadChatId=X&fromSeq=0", async () => {
    const { captured, root, container } = await renderHarness({
      args: { threadId: "thread-abc", threadChatId: "chat-xyz", fromSeq: 0 },
      bearerToken: "tok",
    });

    const agent = captured.at(-1)!;
    expect(agent.url).toBe(
      "/api/ag-ui/thread-abc?threadChatId=chat-xyz&fromSeq=0",
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("includes Authorization header with Bearer token from jotai atom", async () => {
    const { captured, root, container } = await renderHarness({
      args: { threadId: "t1", threadChatId: "c1", fromSeq: 0 },
      bearerToken: "super-secret-token",
    });

    const agent = captured.at(-1)!;
    expect(agent.headers).toEqual({
      Authorization: "Bearer super-secret-token",
    });

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("omits Authorization header when bearer token is null", async () => {
    const { captured, root, container } = await renderHarness({
      args: { threadId: "t1", threadChatId: "c1", fromSeq: 0 },
      bearerToken: null,
    });

    const agent = captured.at(-1)!;
    expect(agent.headers).toEqual({});

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("passes initialMessages and initialState through to HttpAgent", async () => {
    const initialMessages: Message[] = [
      { id: "m1", role: "user", content: "hello" } as Message,
    ];
    const initialState: State = { foo: "bar" };

    const { captured, root, container } = await renderHarness({
      args: {
        threadId: "t1",
        threadChatId: "c1",
        fromSeq: 5,
        initialMessages,
        initialState,
      },
      bearerToken: "tok",
    });

    const agent = captured.at(-1)!;
    expect(agent.threadId).toBe("t1");
    expect(agent.initialMessages).toEqual(initialMessages);
    expect(agent.initialState).toEqual(initialState);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("memoizes: same inputs → same HttpAgent instance across re-renders", async () => {
    const args: TransportArgs = {
      threadId: "t1",
      threadChatId: "c1",
      fromSeq: 0,
    };
    const { captured, rerender, root, container } = await renderHarness({
      args,
      bearerToken: "tok",
    });
    const firstId = captured[0]!.__mockId;

    await rerender({ args: { ...args }, bearerToken: "tok" });

    // Every captured agent so far should be the same instance (same __mockId).
    for (const agent of captured) {
      expect(agent.__mockId).toBe(firstId);
    }
    // Only one HttpAgent ever constructed.
    expect(httpAgentInstances.length).toBe(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("returns a new HttpAgent when threadId changes", async () => {
    const { captured, rerender, root, container } = await renderHarness({
      args: { threadId: "thread-A", threadChatId: "c1", fromSeq: 0 },
      bearerToken: "tok",
    });
    const firstId = captured.at(-1)!.__mockId;

    await rerender({
      args: { threadId: "thread-B", threadChatId: "c1", fromSeq: 0 },
      bearerToken: "tok",
    });
    const secondId = captured.at(-1)!.__mockId;

    expect(secondId).not.toBe(firstId);
    expect(httpAgentInstances.length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("returns a new HttpAgent when fromSeq changes", async () => {
    const { captured, rerender, root, container } = await renderHarness({
      args: { threadId: "t1", threadChatId: "c1", fromSeq: 0 },
      bearerToken: "tok",
    });
    const firstId = captured.at(-1)!.__mockId;

    await rerender({
      args: { threadId: "t1", threadChatId: "c1", fromSeq: 42 },
      bearerToken: "tok",
    });
    const secondId = captured.at(-1)!.__mockId;

    expect(secondId).not.toBe(firstId);
    const lastAgent = captured.at(-1)!;
    expect(lastAgent.url).toBe("/api/ag-ui/t1?threadChatId=c1&fromSeq=42");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("returns a new HttpAgent when threadChatId changes", async () => {
    const { captured, rerender, root, container } = await renderHarness({
      args: { threadId: "t1", threadChatId: "chat-A", fromSeq: 0 },
      bearerToken: "tok",
    });
    const firstId = captured.at(-1)!.__mockId;

    await rerender({
      args: { threadId: "t1", threadChatId: "chat-B", fromSeq: 0 },
      bearerToken: "tok",
    });
    const secondId = captured.at(-1)!.__mockId;

    expect(secondId).not.toBe(firstId);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
