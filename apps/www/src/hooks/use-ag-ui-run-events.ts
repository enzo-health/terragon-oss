"use client";

import type { HttpAgent } from "@ag-ui/client";
import {
  EventType,
  type BaseEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
} from "@ag-ui/core";
import { useEffect, useRef } from "react";

/**
 * Subscribes to AG-UI `RUN_FINISHED` and `RUN_ERROR` events on a given
 * `HttpAgent`. Non-matching events are ignored. When `agent` is null the hook
 * is a no-op.
 *
 * The `onRunFinished` / `onRunError` callbacks are tracked via refs, so
 * changing their identity does NOT re-subscribe. Only a change to `agent`
 * triggers a new subscription. This avoids tearing down the subscription on
 * every render when callers pass inline arrow functions.
 *
 * Thrown errors from handlers are caught and logged — they must not
 * propagate into the `HttpAgent` dispatch loop.
 *
 * This is a sibling to `useAgUiCustomEvents` (which is scoped to CUSTOM
 * events only) so callers can reuse a single pattern for both run-lifecycle
 * and meta event handling without entangling the two.
 */
export function useAgUiRunEvents(
  agent: HttpAgent | null,
  onRunFinished?: (event: RunFinishedEvent) => void,
  onRunError?: (event: RunErrorEvent) => void,
): void {
  const onRunFinishedRef = useRef(onRunFinished);
  const onRunErrorRef = useRef(onRunError);
  // Write refs in render so the subscription always reads the latest callback.
  onRunFinishedRef.current = onRunFinished;
  onRunErrorRef.current = onRunError;

  useEffect(() => {
    if (!agent) return;
    const subscription = agent.subscribe({
      onEvent: ({ event }: { event: BaseEvent }) => {
        if (event.type === EventType.RUN_FINISHED) {
          const handler = onRunFinishedRef.current;
          if (!handler) return;
          try {
            handler(event as RunFinishedEvent);
          } catch (err) {
            console.error("[useAgUiRunEvents] onRunFinished threw", err);
          }
          return;
        }
        if (event.type === EventType.RUN_ERROR) {
          const handler = onRunErrorRef.current;
          if (!handler) return;
          try {
            handler(event as RunErrorEvent);
          } catch (err) {
            console.error("[useAgUiRunEvents] onRunError threw", err);
          }
        }
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [agent]);
}
