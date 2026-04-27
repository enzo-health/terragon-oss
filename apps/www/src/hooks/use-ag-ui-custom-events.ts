"use client";

import type { HttpAgent } from "@ag-ui/client";
import { EventType, type CustomEvent as AgUiCustomEvent } from "@ag-ui/core";
import { useEffect, useRef } from "react";

/**
 * Subscribes to AG-UI CUSTOM events on a given HttpAgent and invokes
 * `onEvent` for those whose `name` passes `filter`.
 *
 * Non-CUSTOM events are ignored. When `agent` is null the hook is a no-op.
 *
 * The `filter` and `onEvent` callbacks are tracked via a ref, so changing
 * them does NOT re-subscribe. Only a change to `agent` triggers a new
 * subscription. This avoids tearing down the subscription on every render
 * when callers pass inline arrow functions.
 *
 * Thrown errors from `onEvent` are caught and logged — they must not
 * propagate into the `HttpAgent` dispatch loop (mirrors the tolerance of
 * the prior PartySocket path).
 *
 * The underlying `HttpAgent.subscribe()` returns `{ unsubscribe }` — the
 * cleanup function calls that, so no stream leaks across agent swaps.
 */
export function useAgUiCustomEvents(
  agent: HttpAgent | null,
  filter: (name: string) => boolean,
  onEvent: (event: AgUiCustomEvent) => void,
): void {
  const filterRef = useRef(filter);
  const onEventRef = useRef(onEvent);
  // Write refs in render so the subscription always reads the latest callbacks
  // even if `agent` changes in the same render as the callbacks. Using a
  // separate useEffect would run AFTER the subscription effect and open a
  // narrow window where the handler is called with stale refs.
  filterRef.current = filter;
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!agent) return;
    const subscription = agent.subscribe({
      onEvent: ({ event }) => {
        if (event.type !== EventType.CUSTOM) return;
        const custom = event as AgUiCustomEvent;
        if (!filterRef.current(custom.name)) return;
        try {
          onEventRef.current(custom);
        } catch (err) {
          // Never let a handler error propagate into the HttpAgent dispatch
          // loop; swallow and log so the subscription stays healthy.
          console.error("[useAgUiCustomEvents] onEvent handler threw", err);
        }
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [agent]);
}
