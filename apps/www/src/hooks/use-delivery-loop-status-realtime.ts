import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import { deliveryLoopStatusQueryKeys } from "@/queries/delivery-loop-status-queries";
import { useRealtimeThread } from "./useRealtime";

type UseDeliveryLoopStatusRealtimeArgs = {
  threadId: string;
  threadChatId: string | undefined;
  onThreadPatches: (patches: BroadcastThreadPatch[]) => void;
  enabled?: boolean;
};

function hasDeliveryLoopRefetchTarget(patch: BroadcastThreadPatch): boolean {
  return (
    patch.op === "refetch" &&
    patch.refetch?.length === 1 &&
    patch.refetch[0] === "delivery-loop"
  );
}

export function useDeliveryLoopStatusRealtime({
  threadId,
  threadChatId,
  onThreadPatches,
  enabled = true,
}: UseDeliveryLoopStatusRealtimeArgs): void {
  const queryClient = useQueryClient();

  const onThreadPatchesWithDeliveryLoopInvalidation = useCallback(
    (patches: BroadcastThreadPatch[]) => {
      if (!enabled) {
        onThreadPatches(patches);
        return;
      }

      if (patches.some(hasDeliveryLoopRefetchTarget)) {
        void queryClient.invalidateQueries(
          {
            queryKey: deliveryLoopStatusQueryKeys.detail(threadId),
          },
          { cancelRefetch: false },
        );
      }

      onThreadPatches(patches);
    },
    [enabled, onThreadPatches, queryClient, threadId],
  );

  useRealtimeThread(
    threadId,
    threadChatId,
    onThreadPatchesWithDeliveryLoopInvalidation,
  );
}
