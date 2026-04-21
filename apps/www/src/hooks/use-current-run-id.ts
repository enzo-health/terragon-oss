"use client";

import type { HttpAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunStartedEvent } from "@ag-ui/core";
import { useEffect, useState } from "react";

/**
 * Track the most recently observed `RUN_STARTED.runId` for a given
 * `HttpAgent`.
 *
 * Phase A of the AG-UI streaming reconnect refactor needs a way for the
 * client to discover the "current" runId so that future reconnects can pass
 * `?runId=X` on the SSE URL instead of `?fromSeq=N`. This hook subscribes to
 * the agent's event stream and updates state whenever a new RUN_STARTED
 * arrives.
 *
 * The initial value is `null` — on a fresh connect we have no runId, and the
 * server falls back to its default "latest run" semantics. Once the first
 * RUN_STARTED arrives the state flips to that runId and stays there (we
 * overwrite on subsequent RUN_STARTEDs because the most recent run is what
 * a future reconnect cares about).
 *
 * Returns `null` when `agent` is null or before any RUN_STARTED has been
 * observed.
 *
 * NOTE: Phase A is read-only — we capture the runId for observability /
 * future wiring, but the transport hook is not forced to reconnect when the
 * runId changes. Phase B will revisit whether to trigger a reconnect.
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
