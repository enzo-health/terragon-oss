"use client";

import type { Message, State } from "@ag-ui/core";
import { HttpAgent } from "@ag-ui/client";
import { useEffect, useMemo } from "react";

/**
 * Browser-side AG-UI transport hook.
 *
 * Wraps `@ag-ui/client`'s `HttpAgent` and points it at the SSE endpoint at
 * `/api/ag-ui/[threadId]`. The endpoint expects `threadChatId` and optionally
 * `runId` as query params. Uses browser session cookies for auth (same-origin
 * fetch), so no Authorization header is set.
 *
 * ### RunId injection (ref-like, via post-commit effect)
 *
 * `HttpAgent` is expensive to reconstruct (each instance closes over its own
 * subscribers, abort controller, and RxJS pipeline). Reconstructing on every
 * `runId` change would tear down the live connection and double the number
 * of in-flight subscriptions the caller has to reason about.
 *
 * Instead we construct `HttpAgent` once per `(threadId, threadChatId)` and
 * mutate `agent.url` imperatively in a post-commit effect whenever the
 * caller-supplied `runId` changes. The next reconnect inside that
 * `HttpAgent` instance picks up the newest runId verbatim; React consumers
 * don't see a new agent reference and don't re-subscribe.
 *
 * ### Initial-connect semantics
 *
 * On fresh mount the client has no captured runId (null). The server falls
 * back to `getLatestRunIdForThreadChat`; on empty thread chats it keeps the
 * stream open and live-tails for the first real RUN_STARTED. Once the
 * client has observed a RUN_STARTED via `useCurrentRunId`, it supplies the
 * captured runId on the next reconnect so the server replays from that
 * run's actual start.
 *
 * Returns `null` when `threadChatId` is `null` or empty — this lets callers
 * render the hook unconditionally while thread/chat data is still loading
 * without constructing an `HttpAgent` pointed at an invalid URL.
 */
export function useAgUiTransport(args: {
  threadId: string;
  threadChatId: string | null;
  /**
   * Captured RUN_STARTED.runId from the current stream, or null when no
   * RUN_STARTED has been observed yet. When non-null the URL carries
   * `?runId=X` so the server replays from the run's real start; when null
   * the server uses its "latest run" default.
   */
  runId?: string | null;
  /** Historical messages to seed the agent with (optional). */
  initialMessages?: Message[];
  /** Initial state snapshot (optional). */
  initialState?: State;
}): HttpAgent | null {
  const { threadId, threadChatId, runId, initialMessages, initialState } = args;

  const agent = useMemo(() => {
    if (!threadChatId) return null;
    const query = new URLSearchParams({ threadChatId });
    const url = `/api/ag-ui/${encodeURIComponent(threadId)}?${query.toString()}`;

    return new HttpAgent({
      url,
      threadId,
      initialMessages,
      initialState,
    });
  }, [initialMessages, initialState, threadChatId, threadId]);

  useEffect(() => {
    if (!agent || !threadChatId) return;
    const query = new URLSearchParams({ threadChatId });
    if (runId) {
      query.set("runId", runId);
    }
    agent.url = `/api/ag-ui/${encodeURIComponent(threadId)}?${query.toString()}`;
  }, [agent, threadId, threadChatId, runId]);

  return agent;
}
