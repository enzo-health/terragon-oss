"use client";

import type { HttpAgent } from "@ag-ui/client";
import type { AIAgent } from "@terragon/agent/types";
import type { UIMessage } from "@terragon/shared";
import { useEffect, useReducer, useRef } from "react";
import {
  agUiMessagesReducer,
  createInitialAgUiMessagesState,
} from "./ag-ui-messages-reducer";

type UseAgUiMessagesArgs = {
  /**
   * The AG-UI HttpAgent subscribed-to by this hook. `null` while the
   * thread chat id is still loading — the hook is a no-op in that case.
   */
  agent: HttpAgent | null;
  /**
   * The agent kind to stamp on newly-created assistant messages. Derived
   * from the active thread chat (`threadChat.agent`).
   */
  agentKind: AIAgent;
  /**
   * UIMessage[] computed from the hydration DBMessages, e.g. via
   * `toUIMessages({ dbMessages, agent })`. These seed the state once per
   * mount; subsequent live updates arrive via the agent's event stream.
   *
   * Passing a new `initialMessages` array reference does NOT reseed the
   * state — use a `key` on the caller to remount if you need to switch
   * threads.
   */
  initialMessages: UIMessage[];
};

/**
 * Produces a `UIMessage[]` projection of the AG-UI event stream. This is
 * the frontend counterpart to the Task 6B flip from the legacy DB-patch
 * pipeline.
 *
 * State is managed with `useReducer` — every AG-UI event the agent emits
 * is dispatched to `agUiMessagesReducer`, which produces the next
 * `UIMessage[]`. The reducer is pure and independently unit-testable.
 *
 * The subscription is torn down on unmount and re-established when the
 * `agent` identity changes (e.g. thread switch).
 */
export function useAgUiMessages({
  agent,
  agentKind,
  initialMessages,
}: UseAgUiMessagesArgs): UIMessage[] {
  // Initialize state ONCE per mount with the hydration messages. The
  // lazy initializer ensures React only runs it on the first render —
  // subsequent renders keep the reduced state even if `initialMessages`
  // changes identity (which it may due to upstream memoization). Callers
  // that truly need to reseed should change the component `key`.
  const [state, dispatch] = useReducer(
    agUiMessagesReducer,
    { agentKind, initialMessages },
    (args: { agentKind: AIAgent; initialMessages: UIMessage[] }) =>
      createInitialAgUiMessagesState(args.agentKind, args.initialMessages),
  );

  // Track the latest dispatch ref so the subscription callback always
  // reads the current dispatcher even if React re-runs the effect.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    if (!agent) return;
    const subscription = agent.subscribe({
      onEvent: ({ event }) => {
        try {
          dispatchRef.current(event);
        } catch (err) {
          // Never let a reducer throw propagate into the HttpAgent
          // dispatch loop; swallow and log so the subscription stays
          // healthy.
          // eslint-disable-next-line no-console
          console.error("[useAgUiMessages] reducer threw", err);
        }
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [agent]);

  return state.messages;
}
