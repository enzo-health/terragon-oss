"use client";

import type { Message, State } from "@ag-ui/core";
import { HttpAgent } from "@ag-ui/client";
import { useMemo } from "react";

/**
 * Browser-side AG-UI transport hook.
 *
 * Wraps `@ag-ui/client`'s `HttpAgent` and points it at the SSE endpoint at
 * `/api/ag-ui/[threadId]`. The endpoint expects `threadChatId` and either
 * `runId` (preferred, Phase A "Replay from Run Start" path) or `fromSeq`
 * (legacy cursor path) as query params for the replay cursor. Uses browser
 * session cookies for auth (same-origin fetch), so no Authorization header is
 * set.
 *
 * The returned `HttpAgent` instance is memoized on the inputs: same inputs →
 * same instance, different inputs → new instance. Callers wiring this into
 * `@assistant-ui/react-ag-ui`'s `useAgUiRuntime` will re-attach when the
 * identity changes (e.g. thread switch).
 *
 * Returns `null` when `threadChatId` is `null` or empty — this lets callers
 * render the hook unconditionally while thread/chat data is still loading
 * without constructing an `HttpAgent` pointed at an invalid URL (which the
 * backend would reject with a 400 the first time any eager prefetch fired).
 */
export function useAgUiTransport(args: {
  threadId: string;
  threadChatId: string | null;
  /**
   * Preferred replay cursor. When provided, the server replays every event
   * in the run (starting with its real RUN_STARTED) and live-tails if the
   * run is still active. Takes precedence over `fromSeq` when both are
   * provided — both sides prefer runId because it avoids RUN_STARTED
   * synthesis at reconnect time.
   */
  runId?: string | null;
  /**
   * Starting seq for initial replay (legacy cursor). 0 means "from the
   * beginning". Ignored when `runId` is also provided.
   */
  fromSeq: number;
  /** Historical messages to seed the agent with (optional). */
  initialMessages?: Message[];
  /** Initial state snapshot (optional). */
  initialState?: State;
}): HttpAgent | null {
  const {
    threadId,
    threadChatId,
    runId,
    fromSeq,
    initialMessages,
    initialState,
  } = args;

  return useMemo(() => {
    if (!threadChatId) return null;
    const query = new URLSearchParams({ threadChatId });
    if (runId) {
      // Prefer the runId cursor. The server uses the run's stored
      // RUN_STARTED as the first event, eliminating the synthesis cascade
      // that plagued the fromSeq path.
      query.set("runId", runId);
    } else {
      query.set("fromSeq", String(fromSeq));
    }
    const url = `/api/ag-ui/${encodeURIComponent(threadId)}?${query.toString()}`;
    return new HttpAgent({
      url,
      threadId,
      initialMessages,
      initialState,
    });
    // Intentionally excluding initialMessages / initialState from deps: those
    // are seed values used once at construction. If callers want to reset
    // seeds they should change threadId/threadChatId/runId/fromSeq.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, threadChatId, runId, fromSeq]);
}
