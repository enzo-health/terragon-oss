/* @vitest-environment jsdom */

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

import { deliveryLoopStatusQueryKeys } from "@/queries/delivery-loop-status-queries";
import { useDeliveryLoopStatusRealtime } from "./use-delivery-loop-status-realtime";

function TestHarness({
  threadId,
  enabled,
  pollIntervalMs,
}: {
  threadId: string;
  enabled?: boolean;
  pollIntervalMs?: number;
}): null {
  useDeliveryLoopStatusRealtime({ threadId, enabled, pollIntervalMs });
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
  let container: HTMLDivElement | null = null;
  let invalidateSpy: MockInstance | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    invalidateSpy?.mockRestore();
    invalidateSpy = null;
    container?.remove();
    container = null;
    vi.useRealTimers();
  });

  it("invalidates delivery-loop status on each poll tick while enabled", async () => {
    const queryClient = createQueryClient();
    invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const root = createRoot(container!);
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(TestHarness, {
            threadId: "thread-1",
            pollIntervalMs: 1000,
          }),
        ),
      );
    });
    expect(invalidateSpy).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenLastCalledWith(
      {
        queryKey: deliveryLoopStatusQueryKeys.detail("thread-1"),
      },
      { cancelRefetch: false },
    );

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(4);

    await act(async () => {
      root.unmount();
    });
  });

  it("skips polling when disabled", async () => {
    const queryClient = createQueryClient();
    invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const root = createRoot(container!);
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(TestHarness, {
            threadId: "thread-1",
            enabled: false,
            pollIntervalMs: 1000,
          }),
        ),
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(invalidateSpy).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("stops invalidating after unmount", async () => {
    const queryClient = createQueryClient();
    invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const root = createRoot(container!);
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(TestHarness, {
            threadId: "thread-1",
            pollIntervalMs: 1000,
          }),
        ),
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });
});
