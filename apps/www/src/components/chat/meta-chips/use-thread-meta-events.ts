import { useCallback, useReducer } from "react";
import type {
  ThreadMetaEvent,
  BootingSubstatus,
} from "@terragon/shared/delivery-loop/thread-meta-event";
import type { CustomEvent as AgUiCustomEvent } from "@ag-ui/core";
import { useAgUiAgent } from "../ag-ui-agent-context";
import { useAgUiCustomEvents } from "@/hooks/use-ag-ui-custom-events";
import { useRealtimeThreadMatch } from "@/hooks/useRealtime";

/**
 * Snapshot of the latest known meta event values for a thread.
 *
 * Populated via `useAgUiCustomEvents` — the backend wraps each
 * `ThreadMetaEvent` as an AG-UI `CUSTOM` event (`name = meta.kind`,
 * `value = meta`) and publishes it on the SSE stream attached to the
 * thread's `HttpAgent`.
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

      // Defense-in-depth dedup: ignore duplicate substatus — the server should
      // already filter these, but guard here too so the reducer stays correct.
      if (
        prevSteps.length > 0 &&
        prevSteps[prevSteps.length - 1]!.substatus === event.to
      ) {
        return state;
      }

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
 * Known `ThreadMetaEvent.kind` values routed through AG-UI CUSTOM events.
 * Kept in sync with `packages/shared/src/delivery-loop/thread-meta-event.ts`.
 * Events NOT in this set are ignored; callers relying on additional kinds
 * must extend this list AND the reducer above.
 */
const THREAD_META_EVENT_KINDS = new Set<string>([
  "thread.token_usage_updated",
  "account.rate_limits_updated",
  "model.rerouted",
  "mcp_server.startup_status_updated",
  "thread.status_changed",
  "config.warning",
  "deprecation.notice",
  "session.initialized",
  "usage.incremental",
  "message.stop",
  "boot.substatus_changed",
  "install.progress",
]);

function isThreadMetaKind(name: string): boolean {
  return THREAD_META_EVENT_KINDS.has(name);
}

/**
 * Accumulates `ThreadMetaEvent`s emitted from the daemon and exposes the
 * latest snapshot for each category.
 *
 * Subscribes to AG-UI CUSTOM events (daemon path) and user-channel broadcast
 * thread patches (server-side setup path) so setup telemetry remains visible
 * before/while daemon streaming starts.
 */
export function useThreadMetaEvents(threadId?: string): {
  snapshot: ThreadMetaSnapshot;
  dispatch: (action: Action) => void;
} {
  const [snapshot, dispatch] = useReducer(reducer, INITIAL);
  const agent = useAgUiAgent();

  const onCustomEvent = useCallback((event: AgUiCustomEvent) => {
    const value = event.value;
    if (value && typeof value === "object" && "kind" in value) {
      dispatch({ event: value as ThreadMetaEvent });
    }
  }, []);

  useAgUiCustomEvents(agent, isThreadMetaKind, onCustomEvent);

  const matchThread = useCallback(
    (patch: { threadId: string }) =>
      threadId !== undefined && patch.threadId === threadId,
    [threadId],
  );
  const onRealtimeThreadChange = useCallback(
    (patches: Array<{ metaEvents?: unknown[] }>) => {
      for (const patch of patches) {
        const metaEvents = patch.metaEvents;
        if (!Array.isArray(metaEvents) || metaEvents.length === 0) {
          continue;
        }
        for (const metaEvent of metaEvents) {
          if (
            metaEvent &&
            typeof metaEvent === "object" &&
            "kind" in metaEvent &&
            typeof metaEvent.kind === "string" &&
            isThreadMetaKind(metaEvent.kind)
          ) {
            dispatch({ event: metaEvent as ThreadMetaEvent });
          }
        }
      }
    },
    [],
  );
  useRealtimeThreadMatch({
    matchThread,
    onThreadChange: onRealtimeThreadChange,
  });

  return { snapshot, dispatch };
}
