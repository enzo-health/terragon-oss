/* @vitest-environment jsdom */

/**
 * Regression test for the readThread re-render loop.
 *
 * Bug (pre-fix): `useMarkChatAsRead` depended on the react-query mutation
 * object inside a useCallback. The mutation hook returns a fresh reference
 * on every render, so any parent re-render regenerated `markAsRead`, which
 * re-fired the effect before `onMutate`'s optimistic cache write had
 * flipped `threadIsUnread` to false. Result: dozens of POSTs per second
 * against the `readThread` server action in dev.
 *
 * Fix: depend only on primitives plus `mutateAsync`, and latch the
 * in-flight chat-id in a ref so the effect is re-entrant-safe.
 *
 * This test forces many parent re-renders while holding `threadIsUnread`
 * true and asserts `readThread` runs at most once.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readThreadSpy = vi.fn(async (_args: unknown) => ({
  ok: true as const,
  data: undefined,
}));
vi.mock("@/server-actions/read-thread", () => ({
  readThread: (args: unknown) => readThreadSpy(args),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

// Must import after vi.mock.
import { useMarkChatAsRead } from "./hooks";

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

beforeEach(() => {
  readThreadSpy.mockClear();
});

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
}

function Harness({
  tickRef,
  isReadOnly = false,
}: {
  tickRef: { setTick: (n: number) => void };
  isReadOnly?: boolean;
}) {
  const [tick, setTick] = useState(0);
  tickRef.setTick = setTick;
  useMarkChatAsRead({
    threadId: "thread-1",
    threadChatId: "chat-1",
    threadIsUnread: true,
    isReadOnly,
  });
  return createElement("div", { "data-tick": tick });
}

describe("useMarkChatAsRead", () => {
  it("fires readThread at most once per (threadId, threadChatId) across many re-renders", async () => {
    const tickRef = { setTick: (_: number) => {} };
    const queryClient = makeQueryClient();
    mount(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Harness, { tickRef }),
      ),
    );

    await act(async () => {
      await Promise.resolve();
    });

    // 20 unrelated parent re-renders. With the pre-fix implementation this
    // would trigger a fresh readThread call on every render.
    for (let i = 1; i <= 20; i++) {
      act(() => {
        tickRef.setTick(i);
      });
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(readThreadSpy).toHaveBeenCalledTimes(1);
  });

  it("does not fire readThread when isReadOnly is true", async () => {
    const tickRef = { setTick: (_: number) => {} };
    const queryClient = makeQueryClient();
    mount(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Harness, { tickRef, isReadOnly: true }),
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(readThreadSpy).not.toHaveBeenCalled();
  });
});
