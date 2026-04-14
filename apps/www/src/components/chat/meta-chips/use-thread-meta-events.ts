import { useReducer } from "react";
import type { ThreadMetaEvent } from "@terragon/shared/delivery-loop/thread-meta-event";

/**
 * Snapshot of the latest known meta event values for a thread.
 *
 * These are populated by the `useThreadMetaEvents` hook.  Backend wiring
 * (adding a `metaEvents` field to `BroadcastThreadPatch` and emitting those
 * events from the daemon-event API route) is a prerequisite for live data;
 * until then the snapshot stays at its zero values.
 */
export interface ThreadMetaSnapshot {
  /** Latest cumulative token usage for this thread's session. */
  tokenUsage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  } | null;

  /** Latest rate-limit record (arbitrary shape from daemon). */
  rateLimits: Record<string, unknown> | null;

  /** Set when the active model was re-routed mid-session. */
  modelReroute: {
    originalModel: string;
    reroutedModel: string;
    reason: string;
  } | null;

  /** Per-server health status (last seen). */
  mcpServerStatus: Record<string, "loading" | "ready" | "error">;
}

type Action = { event: ThreadMetaEvent };

function reducer(
  state: ThreadMetaSnapshot,
  { event }: Action,
): ThreadMetaSnapshot {
  switch (event.kind) {
    case "thread.token_usage_updated":
      return { ...state, tokenUsage: event.usage };
    case "account.rate_limits_updated":
      return { ...state, rateLimits: event.rateLimits };
    case "model.rerouted":
      return {
        ...state,
        modelReroute: {
          originalModel: event.originalModel,
          reroutedModel: event.reroutedModel,
          reason: event.reason,
        },
      };
    case "mcp_server.startup_status_updated":
      return {
        ...state,
        mcpServerStatus: {
          ...state.mcpServerStatus,
          [event.serverName]: event.status,
        },
      };
    // Other event kinds don't affect the chip snapshot
    default:
      return state;
  }
}

const INITIAL: ThreadMetaSnapshot = {
  tokenUsage: null,
  rateLimits: null,
  modelReroute: null,
  mcpServerStatus: {},
};

/**
 * Accumulates `ThreadMetaEvent`s emitted from the daemon and exposes the
 * latest snapshot for each category.
 *
 * Usage:
 * ```tsx
 * const { snapshot, dispatch } = useThreadMetaEvents(threadId);
 * // Pass `dispatch` to the realtime listener once backend wiring lands.
 * ```
 *
 * Wire-up pending:
 *   1. Add `metaEvents?: ThreadMetaEvent[]` to `BroadcastThreadPatch` schema.
 *   2. In the daemon-event API route, broadcast `metaEvents` inside the patch.
 *   3. In the per-thread realtime listener, call `dispatch({ event })` for each.
 */
export function useThreadMetaEvents(_threadId: string): {
  snapshot: ThreadMetaSnapshot;
  dispatch: (action: Action) => void;
} {
  const [snapshot, dispatch] = useReducer(reducer, INITIAL);
  // React's useReducer already returns a stable dispatch reference, so
  // wrapping in useCallback is redundant. Keep the direct reference.
  return { snapshot, dispatch };
}
