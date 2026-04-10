import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliveryLoopStatusQueryKeys } from "@/queries/delivery-loop-status-queries";
import { useDeliveryLoopStatusRealtime } from "./use-delivery-loop-status-realtime";

type UseRealtimeThreadMock = (
  threadId: string,
  threadChatId: string | undefined,
  onThreadPatches: (patches: BroadcastThreadPatch[]) => void,
) => void;

const useRealtimeThreadMock = vi.fn<UseRealtimeThreadMock>();
let activeThreadPatchCallback:
  | ((patches: BroadcastThreadPatch[]) => void)
  | null = null;

vi.mock("./useRealtime", () => {
  return {
    useRealtimeThread: (...args: Parameters<UseRealtimeThreadMock>): void => {
      useRealtimeThreadMock(...args);
      activeThreadPatchCallback = args[2];
    },
  };
});

function TestHarness({
  threadId,
  threadChatId,
  onThreadPatches,
  enabled,
}: {
  threadId: string;
  threadChatId: string | undefined;
  onThreadPatches: (patches: BroadcastThreadPatch[]) => void;
  enabled?: boolean;
}): null {
  useDeliveryLoopStatusRealtime({
    threadId,
    threadChatId,
    onThreadPatches,
    enabled,
  });
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

describe("useDeliveryLoopStatusRealtime", () => {
  beforeEach(() => {
    useRealtimeThreadMock.mockClear();
    activeThreadPatchCallback = null;
  });

  afterEach(() => {
    activeThreadPatchCallback = null;
  });

  it("subscribes to thread realtime updates and invalidates delivery-loop status on explicit refetch", () => {
    const queryClient = createQueryClient();
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");
    const onThreadPatches = vi.fn();

    renderToString(
      <QueryClientProvider client={queryClient}>
        <TestHarness
          threadId="thread-1"
          threadChatId="chat-1"
          onThreadPatches={onThreadPatches}
        />
      </QueryClientProvider>,
    );

    expect(useRealtimeThreadMock).toHaveBeenCalledWith(
      "thread-1",
      "chat-1",
      expect.any(Function),
    );

    activeThreadPatchCallback?.([
      {
        threadId: "thread-1",
        op: "refetch",
        refetch: ["delivery-loop"],
      },
    ]);

    expect(invalidateQueriesSpy).toHaveBeenCalledWith(
      {
        queryKey: deliveryLoopStatusQueryKeys.detail("thread-1"),
      },
      { cancelRefetch: false },
    );
    expect(onThreadPatches).toHaveBeenCalledWith([
      {
        threadId: "thread-1",
        op: "refetch",
        refetch: ["delivery-loop"],
      },
    ]);
  });

  it("ignores non-delivery-loop refetch targets", () => {
    const queryClient = createQueryClient();
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");
    const onThreadPatches = vi.fn();

    renderToString(
      <QueryClientProvider client={queryClient}>
        <TestHarness
          threadId="thread-1"
          threadChatId="chat-1"
          onThreadPatches={onThreadPatches}
        />
      </QueryClientProvider>,
    );

    activeThreadPatchCallback?.([
      {
        threadId: "thread-1",
        op: "refetch",
        refetch: ["shell"],
      },
    ]);

    expect(invalidateQueriesSpy).not.toHaveBeenCalled();
    expect(onThreadPatches).toHaveBeenCalledWith([
      {
        threadId: "thread-1",
        op: "refetch",
        refetch: ["shell"],
      },
    ]);
  });

  it("ignores mixed refetch targets that include delivery-loop", () => {
    const queryClient = createQueryClient();
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");
    const onThreadPatches = vi.fn();

    renderToString(
      <QueryClientProvider client={queryClient}>
        <TestHarness
          threadId="thread-1"
          threadChatId="chat-1"
          onThreadPatches={onThreadPatches}
        />
      </QueryClientProvider>,
    );

    activeThreadPatchCallback?.([
      {
        threadId: "thread-1",
        op: "refetch",
        refetch: ["shell", "delivery-loop"],
      },
    ]);

    expect(invalidateQueriesSpy).not.toHaveBeenCalled();
    expect(onThreadPatches).toHaveBeenCalledWith([
      {
        threadId: "thread-1",
        op: "refetch",
        refetch: ["shell", "delivery-loop"],
      },
    ]);
  });

  it("ignores non-refetch patches that carry a delivery-loop refetch target", () => {
    const queryClient = createQueryClient();
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");
    const onThreadPatches = vi.fn();

    renderToString(
      <QueryClientProvider client={queryClient}>
        <TestHarness
          threadId="thread-1"
          threadChatId="chat-1"
          onThreadPatches={onThreadPatches}
        />
      </QueryClientProvider>,
    );

    activeThreadPatchCallback?.([
      {
        threadId: "thread-1",
        op: "upsert",
        refetch: ["delivery-loop"],
      },
    ]);

    expect(invalidateQueriesSpy).not.toHaveBeenCalled();
    expect(onThreadPatches).toHaveBeenCalledWith([
      {
        threadId: "thread-1",
        op: "upsert",
        refetch: ["delivery-loop"],
      },
    ]);
  });

  it("preserves interleaved delta ordering around delivery-loop refetch patches", () => {
    const queryClient = createQueryClient();
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");
    const observedDeltaSeqs: number[] = [];
    const onThreadPatches = vi.fn((patches: BroadcastThreadPatch[]) => {
      for (const patch of patches) {
        if (patch.op === "delta" && patch.deltaSeq != null) {
          observedDeltaSeqs.push(patch.deltaSeq);
        }
      }
    });

    renderToString(
      <QueryClientProvider client={queryClient}>
        <TestHarness
          threadId="thread-1"
          threadChatId="chat-1"
          onThreadPatches={onThreadPatches}
        />
      </QueryClientProvider>,
    );

    activeThreadPatchCallback?.([
      {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "delta",
        messageId: "message-1",
        partIndex: 0,
        deltaSeq: 10,
        deltaIdempotencyKey: "delta-10",
        deltaKind: "text",
        text: "Hello",
      },
    ]);
    activeThreadPatchCallback?.([
      {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "refetch",
        refetch: ["delivery-loop"],
      },
    ]);
    activeThreadPatchCallback?.([
      {
        threadId: "thread-1",
        threadChatId: "chat-1",
        op: "delta",
        messageId: "message-1",
        partIndex: 0,
        deltaSeq: 11,
        deltaIdempotencyKey: "delta-11",
        deltaKind: "text",
        text: " world",
      },
    ]);

    expect(observedDeltaSeqs).toEqual([10, 11]);
    expect(invalidateQueriesSpy).toHaveBeenCalledTimes(1);
    expect(invalidateQueriesSpy).toHaveBeenCalledWith(
      {
        queryKey: deliveryLoopStatusQueryKeys.detail("thread-1"),
      },
      { cancelRefetch: false },
    );
    expect(onThreadPatches).toHaveBeenNthCalledWith(1, [
      expect.objectContaining({ op: "delta", deltaSeq: 10 }),
    ]);
    expect(onThreadPatches).toHaveBeenNthCalledWith(2, [
      expect.objectContaining({ op: "refetch", refetch: ["delivery-loop"] }),
    ]);
    expect(onThreadPatches).toHaveBeenNthCalledWith(3, [
      expect.objectContaining({ op: "delta", deltaSeq: 11 }),
    ]);
  });
});
