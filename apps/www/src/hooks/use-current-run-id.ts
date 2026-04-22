"use client";

import type { HttpAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunStartedEvent } from "@ag-ui/core";
import { useEffect, useState } from "react";

/**
 * Track the most recently observed `RUN_STARTED.runId` for a given
 * `HttpAgent`.
 *
 * The client needs a way to discover the "current" runId so reconnects can
 * pass `?runId=X` on the SSE URL; the server uses that to replay the run
 * from its real `RUN_STARTED` without synthesizing one. This hook
 * subscribes to the agent's event stream and updates state whenever a new
 * `RUN_STARTED` arrives.
 *
 * The initial value is `null` — on a fresh connect we have no runId, and
 * the server falls back to its "latest run" default (see the SSE route).
 * Once the first `RUN_STARTED` arrives the state flips to that runId and
 * stays there (we overwrite on subsequent `RUN_STARTED`s because the most
 * recent run is what a future reconnect cares about).
 *
 * Consumers pipe the captured runId into `useAgUiTransport`, which mirrors
 * it into `agent.url` imperatively — reconnect-time only, no `HttpAgent`
 * reconstruction — so that the NEXT reconnect lands on the replay-from-run
 * path deterministically.
 *
 * Returns `null` when `agent` is null or before any `RUN_STARTED` has been
 * observed.
 */
export function useCurrentRunId(agent: HttpAgent | null): string | null {
  const [runId, setRunId] = useState<string | null>(null);

  useEffect(() => {
    if (!agent) {
      setRunId(null);
      return;
    }
    const subscription = agent.subscribe({
      onEvent: ({ event }: { event: BaseEvent }) => {
        if (event.type !== EventType.RUN_STARTED) return;
        const candidate = (event as RunStartedEvent).runId;
        if (typeof candidate === "string" && candidate.length > 0) {
          setRunId(candidate);
        }
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [agent]);

  return runId;
}
