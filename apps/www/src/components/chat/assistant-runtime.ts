"use client";

import type { Message as AgUiMessage } from "@ag-ui/core";
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui";
import type { AssistantRuntime } from "@assistant-ui/react";
import type { HttpAgent } from "@ag-ui/client";
import { useMemo } from "react";
import {
  type AgUiHistoryLoader,
  createAgUiHistoryAdapter,
} from "./ag-ui-history-adapter";

const EMPTY_HISTORY_MESSAGES: readonly AgUiMessage[] = [];

/**
 * Terragon chat runtime backed by the AG-UI HttpAgent transport.
 *
 * Phase 4 swap: replaces the previous `useExternalStoreRuntime`-backed runtime
 * (which took pre-computed `UIMessage[]`) with `@assistant-ui/react-ag-ui`'s
 * `useAgUiRuntime`. Messages, tool calls, and thinking deltas flow through the
 * AG-UI SSE stream attached to the `HttpAgent` rather than through a parallel
 * realtime channel.
 *
 * This hook is the single source of `AssistantRuntime` for the chat UI. Actual
 * message rendering in Terragon continues to read from an external
 * `TerragonThreadContext` (Phase 6 migrates rendering onto the runtime as
 * well). The runtime is still required so assistant-ui primitives (e.g.
 * composer, run-state hooks) inside the provider tree behave correctly.
 */
export function useTerragonRuntime({
  agent,
  historyMessages = EMPTY_HISTORY_MESSAGES,
  loadHistoryMessages,
  onError,
  onCancel,
  showThinking = true,
}: {
  agent: HttpAgent;
  historyMessages?: readonly AgUiMessage[];
  loadHistoryMessages?: AgUiHistoryLoader;
  onError?: (error: Error) => void;
  onCancel?: () => void | Promise<void>;
  /**
   * Whether to surface THINKING / reasoning deltas. Callers should set this
   * based on whether the selected agent emits reasoning events; not every
   * agent does. Defaults to `true` for backward compatibility.
   */
  showThinking?: boolean;
}): AssistantRuntime {
  const history = useMemo(
    () =>
      createAgUiHistoryAdapter(loadHistoryMessages ?? (() => historyMessages)),
    [historyMessages, loadHistoryMessages],
  );

  return useAgUiRuntime({
    agent,
    showThinking,
    ...(onError && { onError }),
    ...(onCancel && {
      onCancel: () => {
        void Promise.resolve(onCancel()).catch((error: unknown) => {
          const normalizedError =
            error instanceof Error
              ? error
              : new Error(`Cancel failed: ${String(error)}`);
          onError?.(normalizedError);
        });
      },
    }),
    // History adapter is required to open the SSE stream on mount.
    // `HttpAgent#subscribe()` only registers a callback — it does NOT open
    // a connection. The core opens one only when `agent.runAgent(...)` is
    // called, which happens on mount iff `historyAdapter.load()` returns
    // `{ unstable_resume: true }`. See
    // AgUiThreadRuntimeCore.__internal_load in @assistant-ui/react-ag-ui.
    //
    // The history adapter loads user/system history from the durable AG-UI
    // event log. Rendering still reads from `useThreadViewModel`; `append` is
    // a no-op because follow-ups flow through the `followUp` server action,
    // not through the runtime.
    adapters: {
      history,
    },
  });
}
