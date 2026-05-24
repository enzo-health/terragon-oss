"use client";

import type { Message as AgUiMessage } from "@ag-ui/core";
import type { AssistantRuntime } from "@assistant-ui/react";
import type { HttpAgent } from "@ag-ui/client";
import { useMemo } from "react";
import {
  type AgUiHistoryLoader,
  createAgUiHistoryAdapter,
} from "./ag-ui-history-adapter";
import {
  useTerragonAgUiRuntime,
  type UseTerragonAgUiRuntimeOptions,
} from "./use-terragon-ag-ui-runtime";

const EMPTY_HISTORY_MESSAGES: readonly AgUiMessage[] = [];

/**
 * Terragon chat runtime backed by the AG-UI HttpAgent transport.
 *
 * Messages, tool calls, data parts, and thinking deltas flow through the AG-UI
 * SSE stream attached to the `HttpAgent`.
 *
 * This hook is the single source of `AssistantRuntime` for the chat UI. Actual
 * message rendering now projects assistant-ui runtime messages into the
 * Terragon transcript shape while assistant-ui primitives own run state.
 */
export function useTerragonRuntime({
  agent,
  historyMessages = EMPTY_HISTORY_MESSAGES,
  loadHistoryMessages,
  onError,
  onCancel,
  showThinking = true,
  resumeOnLoad = true,
  historyLoadKey,
  threadId,
  threadChatId,
  queue,
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
  resumeOnLoad?: boolean;
  historyLoadKey?: string;
  /** Thread IDs forwarded to useTerragonAgUiRuntime for the cancel POST. */
  threadId?: string;
  threadChatId?: string;
  queue?: UseTerragonAgUiRuntimeOptions["queue"];
}): AssistantRuntime {
  const history = useMemo(
    () =>
      createAgUiHistoryAdapter(
        async () => {
          try {
            return await (loadHistoryMessages?.() ?? historyMessages);
          } catch (error) {
            const normalizedError =
              error instanceof Error
                ? error
                : new Error(`History load failed: ${String(error)}`);
            onError?.(normalizedError);
            return historyMessages;
          }
        },
        { resumeOnLoad },
      ),
    [historyMessages, loadHistoryMessages, onError, resumeOnLoad],
  );

  const runtimeOptions = useMemo<UseTerragonAgUiRuntimeOptions>(
    () => ({
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
      // event log. Rendering projects the assistant-ui runtime transcript;
      // append is routed through the runtime bridge.
      adapters: {
        history,
      },
      historyLoadKey,
      ...(threadId ? { threadId } : {}),
      ...(threadChatId ? { threadChatId } : {}),
      ...(queue ? { queue } : {}),
    }),
    [
      agent,
      history,
      historyLoadKey,
      onCancel,
      onError,
      showThinking,
      threadId,
      threadChatId,
      queue,
    ],
  );

  return useTerragonAgUiRuntime(runtimeOptions);
}
