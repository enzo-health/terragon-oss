"use client";

import type { HttpAgent } from "@ag-ui/client";
import { EventType, type CustomEvent } from "@ag-ui/core";
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
 * The underlying `HttpAgent.subscribe()` returns `{ unsubscribe }` — the
 * cleanup function calls that, so no stream leaks across agent swaps.
 */
export function useAgUiCustomEvents(
  agent: HttpAgent | null,
  filter: (name: string) => boolean,
  onEvent: (event: CustomEvent) => void,
): void {
  // Track latest callbacks in a ref so the subscription doesn't tear down
  // when the parent passes new inline closures each render.
  const filterRef = useRef(filter);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!agent) return;
    const subscription = agent.subscribe({
      onEvent: ({ event }) => {
        if (event.type !== EventType.CUSTOM) return;
        const custom = event as CustomEvent;
        if (!filterRef.current(custom.name)) return;
        onEventRef.current(custom);
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [agent]);
}
