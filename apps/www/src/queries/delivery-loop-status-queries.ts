import { getDeliveryLoopStatusAction } from "@/server-actions/get-delivery-loop-status";
import { useQuery } from "@tanstack/react-query";
import { getServerActionQueryOptions } from "./server-action-helpers";

export const deliveryLoopStatusQueryKeys = {
  detail: (threadId: string) =>
    ["delivery-loop-status", "detail", threadId] as const,
};

/** @deprecated Use deliveryLoopStatusQueryKeys */
export const sdlcLoopStatusQueryKeys = deliveryLoopStatusQueryKeys;

export function deliveryLoopStatusQueryOptions(threadId: string) {
  return getServerActionQueryOptions({
    queryKey: deliveryLoopStatusQueryKeys.detail(threadId),
    queryFn: async () => {
      return await getDeliveryLoopStatusAction(threadId);
    },
    staleTime: 15_000,
    refetchInterval: (query) => (query.state.data ? 30_000 : 120_000),
  });
}

/** @deprecated Use deliveryLoopStatusQueryOptions */
export const sdlcLoopStatusQueryOptions = deliveryLoopStatusQueryOptions;

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

/** @deprecated Use useDeliveryLoopStatusQuery */
export const useSdlcLoopStatusQuery = useDeliveryLoopStatusQuery;
