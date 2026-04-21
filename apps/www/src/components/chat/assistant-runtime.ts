"use client";

import { useAgUiRuntime } from "@assistant-ui/react-ag-ui";
import type { AssistantRuntime } from "@assistant-ui/react";
import type { HttpAgent } from "@ag-ui/client";

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
  onError,
  onCancel,
  showThinking = true,
}: {
  agent: HttpAgent;
  onError?: (error: Error) => void;
  onCancel?: () => void | Promise<void>;
  /**
   * Whether to surface THINKING / reasoning deltas. Callers should set this
   * based on whether the selected agent emits reasoning events; not every
   * agent does. Defaults to `true` for backward compatibility.
   */
  showThinking?: boolean;
}): AssistantRuntime {
  return useAgUiRuntime({
    agent,
    showThinking,
    ...(onError && { onError }),
    ...(onCancel && {
      onCancel: () => {
        void onCancel();
      },
    }),
    // History adapter is required to open the SSE stream on mount.
    // `HttpAgent#subscribe()` only registers a callback — it does NOT open
    // a connection. The core opens one only when `agent.runAgent(...)` is
    // called, which happens on mount iff `historyAdapter.load()` returns
    // `{ unstable_resume: true }`. See
    // AgUiThreadRuntimeCore.__internal_load in @assistant-ui/react-ag-ui.
    //
    // Returning `messages: []` to the core is safe: our render path reads
    // from `useAgUiMessages` (the reducer seeded from threadChat), not
    // from `core.getMessages()`. `append` is a no-op because follow-ups
    // flow through the `followUp` server action, not through the runtime.
    adapters: {
      history: {
        load: async () => ({
          messages: [],
          unstable_resume: true,
          headId: null,
        }),
        append: async () => {},
      },
    },
  });
}
