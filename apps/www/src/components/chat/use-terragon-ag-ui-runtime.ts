"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useExternalStoreRuntime,
  useRuntimeAdapters,
  type AssistantRuntime,
  type AppendMessage,
  type ExternalStoreAdapter,
  type RuntimeAdapters,
  type ThreadMessage,
} from "@assistant-ui/react";
import { useToolInvocations } from "@assistant-ui/core/react";
import type { ToolExecutionStatus } from "@assistant-ui/core/react";
import type { HttpAgent } from "@ag-ui/client";
import type { ReadonlyJSONValue } from "./ag-ui-custom-parts";
import { TerragonAgUiThreadRuntimeCore } from "./terragon-ag-ui-runtime-core";

type Logger = {
  debug?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
};

type UseTerragonAgUiThreadListAdapter = {
  threadId?: string | undefined;
  onSwitchToNewThread?: (() => Promise<void> | void) | undefined;
  onSwitchToThread?:
    | ((threadId: string) =>
        | Promise<{
            messages: readonly ThreadMessage[];
            state?: ReadonlyJSONValue;
          }>
        | { messages: readonly ThreadMessage[]; state?: ReadonlyJSONValue })
    | undefined;
};

type StoreAdapters = NonNullable<ExternalStoreAdapter["adapters"]>;

export type UseTerragonAgUiRuntimeOptions = {
  agent: HttpAgent;
  logger?: Partial<Logger>;
  showThinking?: boolean;
  onError?: (e: Error) => void;
  onCancel?: () => void;
  historyLoadKey?: string;
  /**
   * Thread IDs required to POST to the cancel endpoint on the server.
   * When provided, onCancel will also POST to /api/ag-ui/[threadId]/cancel
   * so the daemon process is stopped server-side (not just the SSE stream).
   */
  threadId?: string;
  threadChatId?: string;
  adapters?: {
    attachments?: RuntimeAdapters["attachments"];
    speech?: StoreAdapters["speech"];
    dictation?: StoreAdapters["dictation"];
    feedback?: StoreAdapters["feedback"];
    history?: RuntimeAdapters["history"];
    threadList?: UseTerragonAgUiThreadListAdapter;
  };
};

function makeLogger(logger: Partial<Logger> | undefined): Logger {
  return {
    ...(logger?.debug ? { debug: logger.debug } : {}),
    ...(logger?.error ? { error: logger.error } : {}),
  };
}

type RunConfig = NonNullable<AppendMessage["runConfig"]>;

export function useTerragonAgUiRuntime(
  options: UseTerragonAgUiRuntimeOptions,
): AssistantRuntime {
  const logger = useMemo(() => makeLogger(options.logger), [options.logger]);
  const [_version, setVersion] = useState(0);
  const notifyUpdate = useCallback(() => setVersion((v) => v + 1), []);
  const coreRef = useRef<TerragonAgUiThreadRuntimeCore | null>(null);
  // Refs for cancel endpoint IDs — always current regardless of memo staleness.
  const threadIdRef = useRef<string | undefined>(options.threadId);
  const threadChatIdRef = useRef<string | undefined>(options.threadChatId);
  threadIdRef.current = options.threadId;
  threadChatIdRef.current = options.threadChatId;
  const runtimeAdapters = useRuntimeAdapters();

  const historyAdapter = options.adapters?.history ?? runtimeAdapters?.history;
  const threadListAdapter = options.adapters?.threadList;

  if (!coreRef.current) {
    coreRef.current = new TerragonAgUiThreadRuntimeCore({
      agent: options.agent,
      logger,
      showThinking: options.showThinking ?? true,
      ...(options.onError && { onError: options.onError }),
      ...(options.onCancel && { onCancel: options.onCancel }),
      ...(historyAdapter && { history: historyAdapter }),
      notifyUpdate,
    });
  }

  const core = coreRef.current;
  core.updateOptions({
    agent: options.agent,
    logger,
    showThinking: options.showThinking ?? true,
    ...(options.onError && { onError: options.onError }),
    ...(options.onCancel && { onCancel: options.onCancel }),
    ...(historyAdapter && { history: historyAdapter }),
  });

  const [toolStatuses, setToolStatuses] = useState<
    Record<string, ToolExecutionStatus>
  >({});

  const hasExecutingTools = Object.values(toolStatuses).some(
    (status) => status?.type === "executing",
  );

  const [runtimeRef] = useState(() => ({
    get current(): AssistantRuntime {
      return runtime;
    },
  }));

  const toolInvocationsRef = useRef({
    reset: () => {},
    abort: (): Promise<void> => Promise.resolve(),
    resume: (_toolCallId: string, _payload: unknown) => {},
  });

  const threadList = useMemo(() => {
    if (!threadListAdapter) return undefined;

    const { onSwitchToNewThread, onSwitchToThread } = threadListAdapter;

    return {
      threadId: threadListAdapter.threadId,
      onSwitchToNewThread: onSwitchToNewThread
        ? async () => {
            toolInvocationsRef.current.reset();
            await onSwitchToNewThread();
            core.applyExternalMessages([]);
          }
        : undefined,
      onSwitchToThread: onSwitchToThread
        ? async (threadId: string) => {
            toolInvocationsRef.current.reset();
            const result = await onSwitchToThread(threadId);
            core.applyExternalMessages(result.messages);
            if (result.state) {
              core.loadExternalState(result.state);
            }
          }
        : undefined,
    };
  }, [threadListAdapter, core]);

  const adapters = options.adapters;
  const adapterAdapters = useMemo(
    () => ({
      attachments: adapters?.attachments ?? runtimeAdapters?.attachments,
      speech: adapters?.speech,
      dictation: adapters?.dictation,
      feedback: adapters?.feedback,
      threadList,
    }),
    [adapters, runtimeAdapters, threadList],
  );

  const toolInvocations = useToolInvocations({
    state: {
      messages: core.getMessages(),
      isRunning: core.isRunning() || hasExecutingTools,
    },
    getTools: () => runtimeRef.current.thread.getModelContext().tools,
    onResult: (command) => {
      if (command.type !== "add-tool-result") {
        return;
      }
      const messageId = core.findMessageIdForToolCall(command.toolCallId);
      if (!messageId) {
        return;
      }
      core.addToolResult({
        messageId,
        toolCallId: command.toolCallId,
        toolName: command.toolName,
        result: command.result,
        isError: command.isError,
        ...(command.artifact ? { artifact: command.artifact } : {}),
      });
    },
    setToolStatuses,
  });
  toolInvocationsRef.current = toolInvocations;

  const store = useMemo(() => {
    void _version;

    return {
      isLoading: core.isLoading,
      messages: core.getMessages(),
      state: core.getState(),
      isRunning: core.isRunning() || hasExecutingTools,
      onNew: (message: AppendMessage) => core.append(message),
      onEdit: (message: AppendMessage) => core.edit(message),
      onReload: (parentId: string | null, config: { runConfig?: RunConfig }) =>
        core.reload(parentId, config),
      onCancel: async () => {
        await core.cancel();
        // POST to the cancel endpoint so the daemon process is stopped
        // server-side. This is additive — core.cancel() already aborts the
        // SSE stream client-side. The server-side stop is the authoritative
        // signal that halts the delivery loop.
        const threadId = threadIdRef.current;
        const threadChatId = threadChatIdRef.current;
        if (threadId && threadChatId) {
          await fetch(
            `/api/ag-ui/${encodeURIComponent(threadId)}/cancel?threadChatId=${encodeURIComponent(threadChatId)}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            },
          ).catch((err: unknown) => {
            console.error("[useTerragonAgUiRuntime] cancel POST failed", err);
          });
        }
        await toolInvocationsRef.current.abort();
      },
      onAddToolResult: (options) => core.addToolResult(options),
      onResume: (config) => core.resume(config),
      onResumeToolCall: (options) =>
        toolInvocationsRef.current.resume(options.toolCallId, options.payload),
      setMessages: (messages: readonly ThreadMessage[]) =>
        core.applyExternalMessages(messages),
      onImport: (messages: readonly ThreadMessage[]) =>
        core.applyExternalMessages(messages),
      onLoadExternalState: (state: ReadonlyJSONValue) =>
        core.loadExternalState(state),
      adapters: adapterAdapters,
    } satisfies ExternalStoreAdapter<ThreadMessage>;
  }, [adapterAdapters, core, _version, hasExecutingTools]);

  const runtime = useExternalStoreRuntime(store);

  useEffect(() => {
    core.attachRuntime(runtime);
    return () => {
      core.detachRuntime();
    };
  }, [core, runtime]);

  useEffect(() => {
    void core.__internal_load(options.historyLoadKey);
  }, [core, options.historyLoadKey]);

  return runtime;
}
