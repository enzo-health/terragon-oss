/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const applyShellPatch = vi.fn();
const applyChatPatch = vi.fn<
  (patch: BroadcastThreadPatch) => {
    shouldInvalidate: boolean;
  }
>(() => ({ shouldInvalidate: false }));
let registeredOnThreadChange:
  | ((patches: BroadcastThreadPatch[]) => void)
  | null = null;
let registeredMatchThread: ((patch: BroadcastThreadPatch) => boolean) | null =
  null;

vi.mock("@/collections/thread-shell-collection", () => ({
  applyShellPatchToCollection: (patch: BroadcastThreadPatch) =>
    applyShellPatch(patch),
}));
vi.mock("@/collections/thread-chat-collection", () => ({
  applyChatPatchToCollection: (patch: BroadcastThreadPatch) =>
    applyChatPatch(patch),
}));
vi.mock("@/hooks/useRealtime", () => ({
  useRealtimeThreadMatch: ({
    matchThread,
    onThreadChange,
  }: {
    matchThread: (patch: BroadcastThreadPatch) => boolean;
    onThreadChange: (patches: BroadcastThreadPatch[]) => void;
  }) => {
    registeredMatchThread = matchThread;
    registeredOnThreadChange = onThreadChange;
  },
}));

import { useThreadPageRealtimeSync } from "./use-thread-page-realtime-sync";

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

function render(ui: ReactElement): void {
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
}

function HookHost({ threadId }: { threadId: string }): null {
  useThreadPageRealtimeSync({ threadId });
  return null;
}

function makePatch(
  overrides: Partial<BroadcastThreadPatch> = {},
): BroadcastThreadPatch {
  return {
    threadId: "thread-a",
    op: "upsert",
    ...overrides,
  } as BroadcastThreadPatch;
}

beforeEach(() => {
  applyShellPatch.mockClear();
  applyChatPatch.mockClear();
  applyChatPatch.mockImplementation(() => ({ shouldInvalidate: false }));
  registeredOnThreadChange = null;
  registeredMatchThread = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
});

describe("useThreadPageRealtimeSync", () => {
  it("filters patches by threadId", () => {
    render(createElement(HookHost, { threadId: "thread-a" }));
    expect(registeredMatchThread).toBeTruthy();
    expect(registeredMatchThread!(makePatch({ threadId: "thread-a" }))).toBe(
      true,
    );
    expect(registeredMatchThread!(makePatch({ threadId: "thread-b" }))).toBe(
      false,
    );
  });

  it("routes patches to shell + chat collections", () => {
    render(createElement(HookHost, { threadId: "thread-a" }));
    const patch = makePatch({
      threadChatId: "chat-1",
      chat: { agent: "claudeCode" },
    });
    act(() => registeredOnThreadChange!([patch]));
    expect(applyShellPatch).toHaveBeenCalledWith(patch);
    expect(applyChatPatch).toHaveBeenCalledWith(patch);
  });

  it("skips applyChatPatchToCollection when threadChatId is absent", () => {
    render(createElement(HookHost, { threadId: "thread-a" }));
    const patch = makePatch({ shell: { sandboxStatus: "running" } });
    act(() => registeredOnThreadChange!([patch]));
    expect(applyShellPatch).toHaveBeenCalledWith(patch);
    expect(applyChatPatch).not.toHaveBeenCalled();
  });

  it("invalidates the chat query when applyChatPatch reports shouldInvalidate", () => {
    applyChatPatch.mockImplementation(() => ({ shouldInvalidate: true }));
    render(createElement(HookHost, { threadId: "thread-a" }));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const patch = makePatch({ threadChatId: "chat-1", messageSeq: 5 });
    act(() => registeredOnThreadChange!([patch]));
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["threads", "chat", "thread-a", "chat-1"],
      }),
    );
  });

  it("honors patch.refetch directives for shell, chat, and diff", () => {
    render(createElement(HookHost, { threadId: "thread-a" }));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const patch = makePatch({
      threadChatId: "chat-1",
      refetch: ["shell", "chat", "diff"],
    });
    act(() => registeredOnThreadChange!([patch]));
    const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toContainEqual(["threads", "shell", "thread-a"]);
    expect(keys).toContainEqual(["threads", "chat", "thread-a", "chat-1"]);
    expect(keys).toContainEqual(["threads", "diff", "thread-a"]);
  });

  it("dedupes repeated invalidations within one realtime batch", () => {
    applyChatPatch.mockImplementation(() => ({ shouldInvalidate: true }));
    render(createElement(HookHost, { threadId: "thread-a" }));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const patch = makePatch({
      threadChatId: "chat-1",
      messageSeq: 5,
      refetch: ["chat"],
    });

    act(() =>
      registeredOnThreadChange!([
        patch,
        makePatch({
          threadChatId: "chat-1",
          messageSeq: 6,
          refetch: ["chat"],
        }),
      ]),
    );

    const chatInvalidations = invalidate.mock.calls.filter(
      (call) =>
        JSON.stringify(call[0]?.queryKey) ===
        JSON.stringify(["threads", "chat", "thread-a", "chat-1"]),
    );
    expect(chatInvalidations).toHaveLength(1);
  });
});
