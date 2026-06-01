"use client";

import { EventType, type BaseEvent } from "@ag-ui/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useAgUiAgent } from "@/components/chat/ag-ui-agent-context";
import { threadQueryKeys } from "@/queries/thread-queries";
import type { ThreadStatus } from "@terragon/shared";
import { isPrimaryChatLiveThreadStatus } from "@terragon/shared/model/thread-lifecycle-policy";

const HEARTBEAT_MS = 5_000;

/**
 * Invalidates the thread-shell, thread-chat, and thread-list
 * React Query caches when the AG-UI stream emits a terminal run event
 * (`RUN_FINISHED` / `RUN_ERROR`) or a `thread.status_changed` CUSTOM event.
 *
 * This replaces the legacy broadcast-socket patch path that used to push
 * thread status / queued messages / error fields. Rather than patch cached
 * objects directly, we invalidate so React Query refetches the authoritative
 * server-action response — keeping the read path simple and the AG-UI stream
 * purely responsible for event delivery.
 *
 * When `threadChatId` is null the chat invalidation is skipped. When the
 * agent is null the hook is a no-op.
 */
export function useAgUiQueryInvalidator(args: {
  threadId: string;
  threadChatId: string | null;
}): void {
  const agent = useAgUiAgent();
  const scheduleInvalidate = useThreadQueryInvalidationScheduler({
    ...args,
    enabled: Boolean(agent),
  });

  useEffect(() => {
    if (!agent) return;
    const subscription = agent.subscribe({
      onEvent: ({ event }) => {
        if (!shouldInvalidateForAgUiEvent(event)) {
          return;
        }
        scheduleInvalidate();
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [agent, scheduleInvalidate]);
}

export function useThreadQueryInvalidationScheduler(args: {
  threadId: string;
  threadChatId: string | null;
  enabled?: boolean;
}): () => void {
  const { threadId, threadChatId, enabled = true } = args;
  const queryClient = useQueryClient();
  const scheduledInvalidationRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: threadQueryKeys.shell(threadId),
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

  const scheduleInvalidate = useCallback(() => {
    if (scheduledInvalidationRef.current !== null) {
      return;
    }
    scheduledInvalidationRef.current = setTimeout(() => {
      scheduledInvalidationRef.current = null;
      invalidate();
    }, 0);
  }, [invalidate]);

  useEffect(() => {
    if (!enabled) return;

    const interval = setInterval(() => {
      const chatStatus = threadChatId
        ? queryClient.getQueryData<{ status?: ThreadStatus | null }>(
            threadQueryKeys.chat(threadId, threadChatId),
          )?.status
        : undefined;

      const hasFreshEvidence = chatStatus !== undefined;

      // Heartbeat only while the task is plausibly live OR while we're still
      // waiting for any status surface to hydrate (initial load).
      const shouldHeartbeat =
        !hasFreshEvidence ||
        (chatStatus != null && isPrimaryChatLiveThreadStatus(chatStatus));

      if (!shouldHeartbeat) return;
      scheduleInvalidate();
    }, HEARTBEAT_MS);

    return () => {
      clearInterval(interval);
    };
  }, [enabled, queryClient, scheduleInvalidate, threadChatId, threadId]);

  useEffect(
    () => () => {
      if (scheduledInvalidationRef.current !== null) {
        clearTimeout(scheduledInvalidationRef.current);
      }
    },
    [],
  );

  return scheduleInvalidate;
}

function shouldInvalidateForAgUiEvent(event: BaseEvent): boolean {
  if (
    event.type === EventType.RUN_FINISHED ||
    event.type === EventType.RUN_ERROR
  ) {
    return true;
  }
  return (
    event.type === EventType.CUSTOM &&
    Reflect.get(event, "name") === "thread.status_changed"
  );
}
