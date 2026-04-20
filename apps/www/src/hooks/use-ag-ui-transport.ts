"use client";

import type { Message, State } from "@ag-ui/core";
import { HttpAgent } from "@ag-ui/client";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { bearerTokenAtom } from "@/atoms/user";

/**
 * Browser-side AG-UI transport hook.
 *
 * Wraps `@ag-ui/client`'s `HttpAgent` and points it at the SSE endpoint at
 * `/api/ag-ui/[threadId]`. The endpoint expects `threadChatId` and `fromSeq`
 * query params for replay cursor, plus a Bearer token for auth.
 *
 * The returned `HttpAgent` instance is memoized on the inputs: same inputs →
 * same instance, different inputs → new instance. Callers wiring this into
 * `@assistant-ui/react-ag-ui`'s `useAgUiRuntime` will re-attach when the
 * identity changes (e.g. thread switch).
 */
export function useAgUiTransport(args: {
  threadId: string;
  threadChatId: string;
  /** Starting seq for initial replay. 0 means "from the beginning". */
  fromSeq: number;
  /** Historical messages to seed the agent with (optional). */
  initialMessages?: Message[];
  /** Initial state snapshot (optional). */
  initialState?: State;
}): HttpAgent {
  const { threadId, threadChatId, fromSeq, initialMessages, initialState } =
    args;
  const bearerToken = useAtomValue(bearerTokenAtom);

  return useMemo(() => {
    const query = new URLSearchParams({
      threadChatId,
      fromSeq: String(fromSeq),
    });
    const url = `/api/ag-ui/${threadId}?${query.toString()}`;
    const headers: Record<string, string> = bearerToken
      ? { Authorization: `Bearer ${bearerToken}` }
      : {};
    return new HttpAgent({
      url,
      headers,
      threadId,
      initialMessages,
      initialState,
    });
    // Intentionally excluding initialMessages / initialState from deps: those
    // are seed values used once at construction. If callers want to reset
    // seeds they should change threadId/threadChatId/fromSeq.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, threadChatId, fromSeq, bearerToken]);
}
