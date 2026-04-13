import { useQueryClient } from "@tanstack/react-query";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import { useCallback, useEffect, useRef } from "react";
import { shouldRefreshDeliveryLoopStatusFromThreadPatch } from "@/lib/delivery-loop-status";
import { deliveryLoopStatusQueryKeys } from "@/queries/delivery-loop-status-queries";
import { useRealtimeThread } from "./useRealtime";

type UseDeliveryLoopStatusRealtimeArgs = {
  threadId: string;
  threadChatId: string | undefined;
  onThreadPatches: (patches: BroadcastThreadPatch[]) => void;
  enabled?: boolean;
  replayBaseline?: {
    messageSeq: number | null;
    deltaSeq?: number | null;
  };
};

export function resolveDeliveryLoopReconnectState(params: {
  enabled: boolean;
  hasSeenOpen: boolean;
  previousSocketReadyState: number;
  socketReadyState: number;
}): {
  hasSeenOpen: boolean;
  previousSocketReadyState: number;
  shouldInvalidate: boolean;
} {
  if (!params.enabled) {
    return {
      hasSeenOpen: params.hasSeenOpen,
      previousSocketReadyState: params.socketReadyState,
      shouldInvalidate: false,
    };
  }

  if (params.socketReadyState !== WebSocket.OPEN) {
    return {
      hasSeenOpen: params.hasSeenOpen,
      previousSocketReadyState: params.socketReadyState,
      shouldInvalidate: false,
    };
  }

  if (!params.hasSeenOpen) {
    return {
      hasSeenOpen: true,
      previousSocketReadyState: params.socketReadyState,
      shouldInvalidate: false,
    };
  }

  return {
    hasSeenOpen: true,
    previousSocketReadyState: params.socketReadyState,
    shouldInvalidate: params.previousSocketReadyState !== WebSocket.OPEN,
  };
}

export function useDeliveryLoopStatusRealtime({
  threadId,
  threadChatId,
  onThreadPatches,
  enabled = true,
  replayBaseline,
}: UseDeliveryLoopStatusRealtimeArgs): void {
  const queryClient = useQueryClient();
  const hasSeenOpenRef = useRef(false);
  const previousSocketReadyStateRef = useRef<number>(WebSocket.CONNECTING);

  const onThreadPatchesWithDeliveryLoopInvalidation = useCallback(
    (patches: BroadcastThreadPatch[]) => {
      if (!enabled) {
        onThreadPatches(patches);
        return;
      }

      if (patches.some(shouldRefreshDeliveryLoopStatusFromThreadPatch)) {
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

  const { socketReadyState } = useRealtimeThread(
    threadId,
    threadChatId,
    onThreadPatchesWithDeliveryLoopInvalidation,
    replayBaseline,
  );

  useEffect(() => {
    const reconnectState = resolveDeliveryLoopReconnectState({
      enabled,
      hasSeenOpen: hasSeenOpenRef.current,
      previousSocketReadyState: previousSocketReadyStateRef.current,
      socketReadyState,
    });

    hasSeenOpenRef.current = reconnectState.hasSeenOpen;
    previousSocketReadyStateRef.current =
      reconnectState.previousSocketReadyState;

    if (reconnectState.shouldInvalidate) {
      void queryClient.invalidateQueries(
        {
          queryKey: deliveryLoopStatusQueryKeys.detail(threadId),
        },
        { cancelRefetch: false },
      );
    }
  }, [enabled, queryClient, socketReadyState, threadId]);
}
