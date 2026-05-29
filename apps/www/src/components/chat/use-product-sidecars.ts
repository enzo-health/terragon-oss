"use client";

import type { HttpAgent } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import { useThreadQueryInvalidationScheduler } from "@/hooks/use-ag-ui-query-invalidator";
import type { ThreadViewEvent } from "./thread-view-model/types";
import {
  createThreadViewSidecarEventProjector,
  type ThreadViewEventForAgUi,
  useAgUiSidecarRouter,
} from "./use-ag-ui-messages";

const PRODUCT_META_EVENT_KINDS = new Set([
  "thread.token_usage_updated",
  "account.rate_limits_updated",
  "model.rerouted",
  "mcp_server.startup_status_updated",
]);

function isProductSidecarEvent(event: ThreadViewEventForAgUi): boolean {
  switch (event.type) {
    case EventType.RUN_STARTED:
    case EventType.RUN_FINISHED:
    case EventType.RUN_ERROR:
    case EventType.STATE_SNAPSHOT:
    case EventType.STATE_DELTA:
    case EventType.ACTIVITY_SNAPSHOT:
    case EventType.ACTIVITY_DELTA:
      return true;
    case EventType.CUSTOM:
      return isAllowedCustomSidecarEvent(event);
    default:
      return false;
  }
}

function isAllowedCustomSidecarEvent(event: ThreadViewEventForAgUi): boolean {
  const name = Reflect.get(event, "name");
  if (name === "thread.status_changed" || name === "artifact-reference") {
    return true;
  }

  const value = Reflect.get(event, "value");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const kind = Reflect.get(value, "kind");
  return typeof kind === "string" && PRODUCT_META_EVENT_KINDS.has(kind);
}

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
  const projector = createThreadViewSidecarEventProjector();
  const projectProductSidecarEvent = (event: ThreadViewEventForAgUi) =>
    isProductSidecarEvent(event) ? projector(event) : null;
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
