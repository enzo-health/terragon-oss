import { useCallback, useReducer } from "react";
import type { ThreadMetaEvent } from "@terragon/shared/delivery-loop/thread-meta-event";
import {
  getThreadPatches,
  shouldProcessThreadPatch,
  useRealtimeUser,
} from "@/hooks/useRealtime";

/**
 * Snapshot of the latest known meta event values for a thread.
 *
 * Populated via `useRealtimeUser` inside this hook — each incoming
 * BroadcastThreadPatch for the target thread is scanned for `metaEvents`
 * and each one is dispatched through the reducer.
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
 * Subscribes to the user realtime channel and filters incoming broadcast
 * patches for ones targeting `threadId` that carry a `metaEvents` array.
 * Each event is dispatched through the reducer so status chips re-render
 * without refetching chat messages.
 */
export function useThreadMetaEvents(threadId: string): {
  snapshot: ThreadMetaSnapshot;
  dispatch: (action: Action) => void;
} {
  const [snapshot, dispatch] = useReducer(reducer, INITIAL);

  const onMessage = useCallback(
    (message: Parameters<typeof getThreadPatches>[0]) => {
      for (const patch of getThreadPatches(message)) {
        if (
          !shouldProcessThreadPatch({
            patch,
            threadId,
            threadChatId: undefined,
          })
        ) {
          continue;
        }
        const metaEvents = (patch as { metaEvents?: unknown[] }).metaEvents;
        if (!Array.isArray(metaEvents)) continue;
        for (const raw of metaEvents) {
          if (raw && typeof raw === "object" && "kind" in raw) {
            dispatch({ event: raw as ThreadMetaEvent });
          }
        }
      }
    },
    [threadId],
  );

  useRealtimeUser({
    matches: (message) => {
      const patches = getThreadPatches(message);
      return patches.some(
        (p) =>
          p.threadId === threadId &&
          Array.isArray((p as { metaEvents?: unknown[] }).metaEvents),
      );
    },
    onMessage,
    // Meta chips should feel live — no debounce delay on chip updates.
    debounceMs: 0,
  });

  return { snapshot, dispatch };
}
