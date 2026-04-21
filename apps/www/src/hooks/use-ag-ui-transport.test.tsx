/* @vitest-environment jsdom */

import type { Message, State } from "@ag-ui/core";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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

type CapturedValue = CapturedAgent | null;

function requireAgent(value: CapturedValue): CapturedAgent {
  if (!value) throw new Error("expected HttpAgent, got null");
  return value;
}

function Harness({
  args,
  onAgent,
}: {
  args: TransportArgs;
  onAgent: (agent: CapturedValue) => void;
}): null {
  const agent = useAgUiTransport(args);
  useEffect(() => {
    onAgent(agent as unknown as CapturedValue);
  }, [agent, onAgent]);
  // Also capture on URL changes so runId-driven URL mutations are
  // observable to the test harness. The ref-identity-stable agent is
  // mutated in place, so react's effect-deps on the agent alone won't
  // re-fire; we dispatch whenever the args change instead.
  useEffect(() => {
    onAgent(agent as unknown as CapturedValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.runId]);
  return null;
}

async function renderHarness({ args }: { args: TransportArgs }): Promise<{
  container: HTMLDivElement;
  root: Root;
  captured: CapturedValue[];
  rerender: (next: { args: TransportArgs }) => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const captured: CapturedValue[] = [];
  const onAgent = (agent: CapturedValue) => {
    captured.push(agent);
  };

  await act(async () => {
    root.render(createElement(Harness, { args, onAgent }));
  });

  const rerender = async (next: { args: TransportArgs }) => {
    await act(async () => {
      root.render(createElement(Harness, { args: next.args, onAgent }));
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
      args: { threadId: "t1", threadChatId: "c1" },
    });

    expect(captured.length).toBeGreaterThan(0);
    const first = requireAgent(captured[0]!);
    expect(typeof first.__mockId).toBe("number");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("constructs the initial URL without a runId param (server falls back to latest-run)", async () => {
    const { captured, root, container } = await renderHarness({
      args: { threadId: "thread-abc", threadChatId: "chat-xyz" },
    });

    const agent = requireAgent(captured.at(-1)!);
    expect(agent.url).toBe("/api/ag-ui/thread-abc?threadChatId=chat-xyz");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("URL-encodes threadId and threadChatId query params", async () => {
    const { captured, root, container } = await renderHarness({
      args: {
        threadId: "thread/with space",
        threadChatId: "a&b=c",
      },
    });

    const agent = requireAgent(captured.at(-1)!);
    // URLSearchParams encodes '&' → %26, '=' → %3D.
    // encodeURIComponent encodes '/' → %2F, ' ' → %20.
    expect(agent.url).toBe(
      "/api/ag-ui/thread%2Fwith%20space?threadChatId=a%26b%3Dc",
    );

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
        initialMessages,
        initialState,
      },
    });

    const agent = requireAgent(captured.at(-1)!);
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
    };
    const { captured, rerender, root, container } = await renderHarness({
      args,
    });
    const firstId = requireAgent(captured[0]!).__mockId;

    await rerender({ args: { ...args } });

    // Every captured agent so far should be the same instance (same __mockId).
    for (const agent of captured) {
      expect(requireAgent(agent).__mockId).toBe(firstId);
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
      args: { threadId: "thread-A", threadChatId: "c1" },
    });
    const firstId = requireAgent(captured.at(-1)!).__mockId;

    await rerender({
      args: { threadId: "thread-B", threadChatId: "c1" },
    });
    const secondId = requireAgent(captured.at(-1)!).__mockId;

    expect(secondId).not.toBe(firstId);
    expect(httpAgentInstances.length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("returns a new HttpAgent when threadChatId changes", async () => {
    const { captured, rerender, root, container } = await renderHarness({
      args: { threadId: "t1", threadChatId: "chat-A" },
    });
    const firstId = requireAgent(captured.at(-1)!).__mockId;

    await rerender({
      args: { threadId: "t1", threadChatId: "chat-B" },
    });
    const secondId = requireAgent(captured.at(-1)!).__mockId;

    expect(secondId).not.toBe(firstId);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("mutates agent.url in place on runId change — does NOT reconstruct HttpAgent", async () => {
    // RunId captured off the live RUN_STARTED stream must be reflected in
    // the URL used for the next reconnect. But the hot HttpAgent instance
    // closes over its subscribers and abort controller, so we MUST NOT
    // reconstruct on each runId change (that would tear down active
    // subscriptions and double the load on the server).
    const { captured, rerender, root, container } = await renderHarness({
      args: { threadId: "t1", threadChatId: "c1", runId: null },
    });
    const firstAgent = requireAgent(captured.at(-1)!);
    expect(firstAgent.url).toBe("/api/ag-ui/t1?threadChatId=c1");

    await rerender({
      args: { threadId: "t1", threadChatId: "c1", runId: "run-xyz" },
    });

    // Same HttpAgent instance (no reconstruction).
    expect(httpAgentInstances.length).toBe(1);
    expect(requireAgent(captured.at(-1)!).__mockId).toBe(firstAgent.__mockId);
    // URL mutated in place to include the captured runId.
    expect(firstAgent.url).toBe("/api/ag-ui/t1?threadChatId=c1&runId=run-xyz");

    // And again on a subsequent runId update — still the same instance.
    await rerender({
      args: { threadId: "t1", threadChatId: "c1", runId: "run-next" },
    });
    expect(httpAgentInstances.length).toBe(1);
    expect(firstAgent.url).toBe("/api/ag-ui/t1?threadChatId=c1&runId=run-next");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("clears runId from the URL when runId becomes null (thread-switch reset)", async () => {
    const { captured, rerender, root, container } = await renderHarness({
      args: { threadId: "t1", threadChatId: "c1", runId: "run-xyz" },
    });
    const firstAgent = requireAgent(captured.at(-1)!);
    // First render: useEffect syncs the URL to include runId.
    expect(firstAgent.url).toBe("/api/ag-ui/t1?threadChatId=c1&runId=run-xyz");

    await rerender({
      args: { threadId: "t1", threadChatId: "c1", runId: null },
    });
    // runId cleared — URL drops the query param so the server re-runs its
    // "latest run" fallback on the next reconnect.
    expect(firstAgent.url).toBe("/api/ag-ui/t1?threadChatId=c1");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("returns null when threadChatId is null", async () => {
    const { captured, root, container } = await renderHarness({
      args: { threadId: "t1", threadChatId: null },
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured.at(-1)!).toBeNull();
    // No HttpAgent constructed for a null threadChatId.
    expect(httpAgentInstances.length).toBe(0);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("returns null when threadChatId is an empty string", async () => {
    const { captured, root, container } = await renderHarness({
      args: { threadId: "t1", threadChatId: "" },
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured.at(-1)!).toBeNull();
    expect(httpAgentInstances.length).toBe(0);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("transitions from null to HttpAgent when threadChatId becomes available", async () => {
    const { captured, rerender, root, container } = await renderHarness({
      args: { threadId: "t1", threadChatId: null },
    });

    expect(captured.at(-1)!).toBeNull();
    expect(httpAgentInstances.length).toBe(0);

    await rerender({
      args: { threadId: "t1", threadChatId: "c1" },
    });

    const latest = requireAgent(captured.at(-1)!);
    expect(latest.url).toBe("/api/ag-ui/t1?threadChatId=c1");
    expect(httpAgentInstances.length).toBe(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
