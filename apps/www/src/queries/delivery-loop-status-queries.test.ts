import { serverActionSuccess } from "@/lib/server-actions";
import { getDeliveryLoopStatusAction } from "@/server-actions/get-delivery-loop-status";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deliveryLoopStatusQueryKeys,
  deliveryLoopStatusQueryOptions,
} from "./delivery-loop-status-queries";

vi.mock("@/server-actions/get-delivery-loop-status", () => {
  return {
    getDeliveryLoopStatusAction: vi.fn(),
  };
});

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const startTime = Date.now();

  while (!condition()) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function createMockDeliveryLoopStatus(updatedAtIso: string) {
  return {
    loopId: "loop-1",
    state: "planning" as const,
    planApprovalPolicy: "auto" as const,
    stateLabel: "Planning",
    explanation: "Agent is drafting an implementation plan before coding.",
    blockedReason: null,
    progressPercent: 10,
    actions: {
      canResume: false,
      canBypassOnce: false,
      canApprovePlan: false,
    },
    phases: [
      {
        key: "planning" as const,
        label: "Planning",
        status: "pending" as const,
      },
    ],
    checks: [],
    needsAttention: {
      isBlocked: false,
      blockerCount: 0,
      topBlockers: [],
    },
    links: {
      pullRequestUrl: null,
      statusCommentUrl: null,
      checkRunUrl: null,
    },
    artifacts: {
      planningArtifact: null,
      implementationArtifact: null,
      plannedTaskSummary: {
        total: 0,
        done: 0,
        remaining: 0,
      },
      plannedTasks: [],
    },
    updatedAtIso,
  };
}

describe("deliveryLoopStatusQueryOptions", () => {
  beforeEach(() => {
    vi.mocked(getDeliveryLoopStatusAction).mockReset();
  });

  it("uses a constant five-minute heartbeat refetch interval", () => {
    const options = deliveryLoopStatusQueryOptions("thread-1");

    expect(options.staleTime).toBe(15_000);
    expect(options.refetchInterval).toBe(300_000);
  });

  it("dedupes explicit invalidations while a delivery-loop refetch is already in flight", async () => {
    const queryClient = createQueryClient();
    const queryKey = deliveryLoopStatusQueryKeys.detail("thread-1");
    const inFlightResponse =
      createDeferred<Awaited<ReturnType<typeof getDeliveryLoopStatusAction>>>();

    queryClient.setQueryData(
      queryKey,
      createMockDeliveryLoopStatus("2026-04-10T00:00:00.000Z"),
    );
    vi.mocked(getDeliveryLoopStatusAction).mockImplementationOnce(
      async () => inFlightResponse.promise,
    );

    const observer = new QueryObserver(
      queryClient,
      deliveryLoopStatusQueryOptions("thread-1"),
    );
    const unsubscribe = observer.subscribe(() => {});

    try {
      const heartbeatRefetch = observer.refetch();

      await waitFor(
        () => vi.mocked(getDeliveryLoopStatusAction).mock.calls.length === 1,
      );

      const firstInvalidation = queryClient.invalidateQueries(
        { queryKey },
        { cancelRefetch: false },
      );
      const secondInvalidation = queryClient.invalidateQueries(
        { queryKey },
        { cancelRefetch: false },
      );

      expect(getDeliveryLoopStatusAction).toHaveBeenCalledTimes(1);

      inFlightResponse.resolve(
        serverActionSuccess(
          createMockDeliveryLoopStatus("2026-04-10T00:05:00.000Z"),
        ),
      );

      await Promise.all([
        heartbeatRefetch,
        firstInvalidation,
        secondInvalidation,
      ]);
      await waitFor(
        () => queryClient.getQueryState(queryKey)?.fetchStatus === "idle",
      );

      expect(getDeliveryLoopStatusAction).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });
});
