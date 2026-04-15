import { useCallback, useReducer } from "react";
import type {
  ThreadMetaEvent,
  BootingSubstatus,
} from "@terragon/shared/delivery-loop/thread-meta-event";
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

  /**
   * Ordered list of boot steps received via `boot.substatus_changed` events.
   * Each entry records the substatus, when it started, and (once the next
   * step arrives) when it completed with its duration.
   */
  bootSteps: Array<{
    substatus: BootingSubstatus;
    /** ISO 8601 timestamp of when this step started. */
    startedAt: string;
    /** ISO 8601 timestamp of when this step completed (set by the next event). */
    completedAt?: string;
    /** Duration of this step in milliseconds. */
    durationMs?: number;
  }>;

  /**
   * Latest install progress snapshot from `install.progress` events.
   * Null until the first such event arrives.
   */
  installProgress: {
    resolved: number;
    reused: number;
    downloaded: number;
    added: number;
    total?: number;
    currentPackage?: string;
    elapsedMs: number;
  } | null;
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
    case "boot.substatus_changed": {
      const prevSteps = state.bootSteps;

      // Mark the previous (last) step as completed with durationMs from the event.
      let updatedSteps = prevSteps;
      if (prevSteps.length > 0 && event.durationMs !== undefined) {
        const last = prevSteps[prevSteps.length - 1]!;
        updatedSteps = [
          ...prevSteps.slice(0, -1),
          {
            ...last,
            completedAt: event.timestamp,
            durationMs: event.durationMs,
          },
        ];
      } else if (prevSteps.length > 0 && event.durationMs === undefined) {
        // Compute duration from timestamps if not provided.
        const last = prevSteps[prevSteps.length - 1]!;
        const computedMs =
          new Date(event.timestamp).getTime() -
          new Date(last.startedAt).getTime();
        updatedSteps = [
          ...prevSteps.slice(0, -1),
          {
            ...last,
            completedAt: event.timestamp,
            durationMs: computedMs >= 0 ? computedMs : undefined,
          },
        ];
      }

      // Append the new step.
      return {
        ...state,
        bootSteps: [
          ...updatedSteps,
          { substatus: event.to, startedAt: event.timestamp },
        ],
      };
    }
    case "install.progress":
      return {
        ...state,
        installProgress: {
          resolved: event.resolved,
          reused: event.reused,
          downloaded: event.downloaded,
          added: event.added,
          total: event.total,
          currentPackage: event.currentPackage,
          elapsedMs: event.elapsedMs,
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
  bootSteps: [],
  installProgress: null,
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
