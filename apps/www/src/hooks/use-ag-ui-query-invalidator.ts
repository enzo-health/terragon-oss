"use client";

import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAgUiAgent } from "@/components/chat/ag-ui-agent-context";
import { useAgUiCustomEvents } from "@/hooks/use-ag-ui-custom-events";
import { useAgUiRunEvents } from "@/hooks/use-ag-ui-run-events";
import { deliveryLoopStatusQueryKeys } from "@/queries/delivery-loop-status-queries";
import { threadQueryKeys } from "@/queries/thread-queries";
import type { DeliveryLoopState, ThreadStatus } from "@terragon/shared";

const HEARTBEAT_MS = 15_000;

const LIVE_THREAD_STATUSES = new Set<ThreadStatus>([
  // Legacy/deprecated: keep polling for safety while these are still in play.
  "queued-blocked",
  "working-stopped",
  // Queued / booting / active.
  "queued",
  "queued-tasks-concurrency",
  "queued-sandbox-creation-rate-limit",
  "queued-agent-rate-limit",
  "booting",
  "working",
  "stopping",
  // Transitional: agent messages are done but the thread is still wrapping up.
  "working-error",
  "working-done",
  "checkpointing",
]);

const LIVE_DELIVERY_LOOP_STATES = new Set<DeliveryLoopState>([
  "planning",
  "implementing",
  "review_gate",
  "ci_gate",
  "awaiting_pr_link",
  "babysitting",
  "blocked",
]);

/**
 * Invalidates the thread-shell, thread-chat, and delivery-loop-status
 * React Query caches when the AG-UI stream emits a terminal run event
 * (`RUN_FINISHED` / `RUN_ERROR`) or a `thread.status_changed` CUSTOM event.
 *
 * This replaces the legacy broadcast-socket patch path that used to push
 * thread status / queued messages / error fields AND the 15s polling
 * fallback for the delivery-loop stepper. Rather than patch cached objects
 * directly, we invalidate so React Query refetches the authoritative
 * server-action response — keeping the read path simple and the AG-UI
 * stream purely responsible for event delivery.
 *
 * When `threadChatId` is null the chat invalidation is skipped (shell and
 * delivery-loop still fire). When the agent is null the hook is a no-op.
 */
export function useAgUiQueryInvalidator(args: {
  threadId: string;
  threadChatId: string | null;
}): void {
  const { threadId, threadChatId } = args;
  const queryClient = useQueryClient();
  const agent = useAgUiAgent();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: threadQueryKeys.shell(threadId),
    });
    void queryClient.invalidateQueries({
      queryKey: deliveryLoopStatusQueryKeys.detail(threadId),
    });
    // Keep sidebar list queries converged with the open task after missed
    // stream events (broadcast patches are best-effort, not authoritative).
    void queryClient.invalidateQueries({
      queryKey: threadQueryKeys.list(null),
    });
    if (threadChatId) {
      void queryClient.invalidateQueries({
        queryKey: threadQueryKeys.chat(threadId, threadChatId),
      });
    }
  }, [queryClient, threadId, threadChatId]);

  const statusFilter = useCallback(
    (name: string) => name === "thread.status_changed",
    [],
  );

  useAgUiCustomEvents(agent, statusFilter, invalidate);
  useAgUiRunEvents(agent, invalidate, invalidate);

  useEffect(() => {
    if (!agent) return;

    const interval = setInterval(() => {
      const chatStatus = threadChatId
        ? queryClient.getQueryData<{ status?: ThreadStatus | null }>(
            threadQueryKeys.chat(threadId, threadChatId),
          )?.status
        : undefined;

      const deliveryState = queryClient.getQueryData<{
        state?: DeliveryLoopState | null;
      }>(deliveryLoopStatusQueryKeys.detail(threadId))?.state;

      const hasFreshEvidence =
        chatStatus !== undefined || deliveryState !== undefined;

      // Heartbeat only while the task is plausibly live OR while we're still
      // waiting for any status surface to hydrate (initial load).
      const shouldHeartbeat =
        !hasFreshEvidence ||
        (chatStatus != null && LIVE_THREAD_STATUSES.has(chatStatus)) ||
        (deliveryState != null && LIVE_DELIVERY_LOOP_STATES.has(deliveryState));

      if (!shouldHeartbeat) return;
      invalidate();
    }, HEARTBEAT_MS);

    return () => {
      clearInterval(interval);
    };
  }, [agent, invalidate, queryClient, threadChatId, threadId]);
}
