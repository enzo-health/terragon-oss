"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAgUiAgent } from "@/components/chat/ag-ui-agent-context";
import { useAgUiCustomEvents } from "@/hooks/use-ag-ui-custom-events";
import { useAgUiRunEvents } from "@/hooks/use-ag-ui-run-events";
import { deliveryLoopStatusQueryKeys } from "@/queries/delivery-loop-status-queries";
import { threadQueryKeys } from "@/queries/thread-queries";

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
}
