/* @vitest-environment jsdom */

import type { AbstractAgent } from "@ag-ui/client";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgUiHistoryMessagesResult } from "@/lib/ag-ui-history-types";
import {
  type UseLiveTranscriptArgs,
  useLiveTranscript,
} from "./use-live-transcript";

const mounted: Array<() => void> = [];

beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

function renderLiveTranscript(initial: UseLiveTranscriptArgs): {
  result: { current: ReturnType<typeof useLiveTranscript> };
  rerender: (props: UseLiveTranscriptArgs) => Promise<void>;
} {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  const result = {
    current: undefined as unknown as ReturnType<typeof useLiveTranscript>,
  };
  let setProps: (p: UseLiveTranscriptArgs) => void = () => {};

  function Harness({ initial: init }: { initial: UseLiveTranscriptArgs }) {
    const [props, setInner] = useState(init);
    setProps = setInner;
    result.current = useLiveTranscript(props);
    return null;
  }

  act(() => {
    root.render(createElement(Harness, { initial }));
  });
  mounted.push(() => act(() => root.unmount()));

  return {
    result,
    rerender: async (props) => {
      await act(async () => {
        setProps(props);
      });
    },
  };
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function makeAgent(): {
  agent: AbstractAgent;
  runAgent: ReturnType<typeof vi.fn>;
} {
  const runAgent = vi.fn(() =>
    Promise.reject(new Error("persistent verifier failure")),
  );
  const agent = {
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    runAgent,
    abortRun: vi.fn(),
  } as unknown as AbstractAgent;
  return { agent, runAgent };
}

function makeArgs(
  agent: AbstractAgent,
  overrides: Partial<UseLiveTranscriptArgs> = {},
): UseLiveTranscriptArgs {
  return {
    agent,
    loadHistory: (): Promise<AgUiHistoryMessagesResult> =>
      Promise.resolve({
        messages: [],
        lastSeq: 0,
        runActive: true,
        activeRunId: "run-1",
      }),
    isAgentWorking: true,
    setReplayCursor: vi.fn(),
    serverRetry: vi.fn(async () => {}),
    isServerRetrying: false,
    ...overrides,
  };
}

describe("useLiveTranscript resume reconnect guard", () => {
  it("bounds reconnect attempts when a verifier throw persists across effect re-runs", async () => {
    const { agent, runAgent } = makeAgent();
    const { result, rerender } = renderLiveTranscript(makeArgs(agent));

    await settle(30);
    await rerender(makeArgs(agent));
    await settle(400);
    await rerender(makeArgs(agent));
    await settle(750);
    await rerender(makeArgs(agent));
    await settle(50);

    expect(runAgent.mock.calls.length).toBe(3);
    expect(result.current.errorInfo).toBe("persistent verifier failure");

    await rerender(makeArgs(agent));
    await settle(50);
    expect(runAgent.mock.calls.length).toBe(3);
  }, 15_000);

  it("resets the reconnect budget on a manual retry", async () => {
    const { agent, runAgent } = makeAgent();
    const { result, rerender } = renderLiveTranscript(makeArgs(agent));

    await settle(30);
    await rerender(makeArgs(agent));
    await settle(400);
    await rerender(makeArgs(agent));
    await settle(750);
    await rerender(makeArgs(agent));
    await settle(50);
    expect(runAgent.mock.calls.length).toBe(3);

    await act(async () => {
      await result.current.handleRetry?.();
    });
    await settle(50);

    expect(runAgent.mock.calls.length).toBe(4);
  }, 15_000);
});
