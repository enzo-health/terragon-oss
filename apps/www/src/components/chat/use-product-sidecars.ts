"use client";

import type { HttpAgent } from "@ag-ui/client";
import { useThreadQueryInvalidationScheduler } from "@/hooks/use-ag-ui-query-invalidator";
import { createProductSidecarEventProjector } from "./thread-view-model/sidecars";
import type { ThreadViewEvent } from "./thread-view-model/types";
import {
  type ThreadViewEventForAgUi,
  useAgUiSidecarRouter,
} from "./use-thread-view-model";

export function useProductSidecars({
  agent,
  threadId,
  threadChatId,
  dispatchThreadViewEvent,
}: {
  agent: HttpAgent | null;
  threadId: string;
  threadChatId: string;
  dispatchThreadViewEvent: (event: ThreadViewEvent) => void;
}): void {
  const projectProductSidecarEvent =
    createProductSidecarEventProjector<ThreadViewEventForAgUi>();
  const scheduleThreadQueryInvalidation = useThreadQueryInvalidationScheduler({
    threadId,
    threadChatId,
    enabled: Boolean(agent),
  });

  useAgUiSidecarRouter({
    agent,
    dispatchThreadViewEvent,
    projectEvent: projectProductSidecarEvent,
    onStatusOrTerminalEvent: scheduleThreadQueryInvalidation,
  });
}
