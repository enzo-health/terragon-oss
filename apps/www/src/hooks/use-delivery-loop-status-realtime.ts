import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { deliveryLoopStatusQueryKeys } from "@/queries/delivery-loop-status-queries";

type UseDeliveryLoopStatusRealtimeArgs = {
  threadId: string;
  enabled?: boolean;
  /** Poll interval for delivery-loop status refreshes. Default 15s. */
  pollIntervalMs?: number;
};

const DEFAULT_POLL_INTERVAL_MS = 15_000;

/**
 * Keeps the delivery-loop status query fresh without the legacy broadcast
 * socket. After the AG-UI migration the dedicated per-thread broadcast
 * subscription was removed — status freshness on the chat page comes from:
 *
 *   - `RUN_FINISHED` / `thread.status_changed` invalidations fired from
 *     `useAgUiRunEvents` / `useAgUiCustomEvents` in `chat-ui.tsx`
 *   - React Query refetch-on-focus
 *   - A low-frequency polling fallback driven by this hook, so the
 *     delivery-loop progress stepper catches transitions that don't
 *     produce an AG-UI terminal event (e.g. gate outcomes that close out
 *     the active run before the stepper is mounted).
 *
 * The hook is intentionally a no-op when `enabled` is false so non-opted-in
 * threads don't trigger periodic invalidations.
 */
export function useDeliveryLoopStatusRealtime({
  threadId,
  enabled = true,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: UseDeliveryLoopStatusRealtimeArgs): void {
  const queryClient = useQueryClient();
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  useEffect(() => {
    if (!enabled) return;
    if (pollIntervalMs <= 0) return;
    const handle = setInterval(() => {
      void queryClient.invalidateQueries(
        {
          queryKey: deliveryLoopStatusQueryKeys.detail(threadIdRef.current),
        },
        { cancelRefetch: false },
      );
    }, pollIntervalMs);
    return () => clearInterval(handle);
  }, [enabled, pollIntervalMs, queryClient]);
}
