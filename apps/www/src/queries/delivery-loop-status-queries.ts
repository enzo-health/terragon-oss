import { getDeliveryLoopStatusAction } from "@/server-actions/get-delivery-loop-status";
import { useQuery } from "@tanstack/react-query";
import { getServerActionQueryOptions } from "./server-action-helpers";

export const deliveryLoopStatusQueryKeys = {
  detail: (threadId: string) =>
    ["delivery-loop-status", "detail", threadId] as const,
};

export function deliveryLoopStatusQueryOptions(threadId: string) {
  return getServerActionQueryOptions({
    queryKey: deliveryLoopStatusQueryKeys.detail(threadId),
    queryFn: async () => {
      return await getDeliveryLoopStatusAction(threadId);
    },
    staleTime: 15_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) {
        // No data yet - poll less aggressively
        return 120_000;
      }
      // Active delivery loop phases need more frequent updates
      const activeStates = [
        "planning",
        "implementing",
        "review_gate",
        "ci_gate",
        "ui_gate",
        "babysitting",
      ] as const;
      if (activeStates.includes(data.state as (typeof activeStates)[number])) {
        return 15_000; // 15s for active phases
      }
      // Blocked states still need polling but less frequently
      if (data.state === "blocked" || data.state === "awaiting_pr_link") {
        return 30_000; // 30s for blocked/waiting states
      }
      // Terminal states can poll less frequently
      return 60_000; // 60s for terminal states
    },
  });
}

export function useDeliveryLoopStatusQuery({
  threadId,
  enabled = true,
}: {
  threadId: string;
  enabled?: boolean;
}) {
  return useQuery({
    ...deliveryLoopStatusQueryOptions(threadId),
    enabled,
  });
}
