"use client";

import type { HttpAgent } from "@ag-ui/client";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  useAgUiRuntime,
  type UseAgUiRuntimeOptions,
} from "@assistant-ui/react-ag-ui";
import type { AIAgent } from "@terragon/agent/types";
import { useCallback, useMemo, useState } from "react";
import type { AgUiHistoryMessagesResult } from "@/lib/ag-ui-history-types";
import { createAgUiHistoryAdapter } from "../ag-ui-history-adapter";

function applyReplayCursorToAgent(agent: HttpAgent, lastSeq: number): void {
  const url = new URL(agent.url, "http://terragon.local");
  url.searchParams.set("fromSeq", String(lastSeq));
  agent.url = `${url.pathname}?${url.searchParams.toString()}`;
}

class TerragonHistoryLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerragonHistoryLoadError";
  }
}

async function postTerragonCancel({
  threadId,
  threadChatId,
  onError,
}: {
  threadId: string;
  threadChatId: string;
  onError?: (error: Error) => void;
}): Promise<void> {
  try {
    const response = await fetch(
      `/api/ag-ui/${encodeURIComponent(threadId)}/cancel?threadChatId=${encodeURIComponent(threadChatId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        errorText
          ? `Cancel failed: ${errorText}`
          : `Cancel failed with status ${response.status}`,
      );
    }
  } catch (error) {
    const normalizedError =
      error instanceof Error
        ? error
        : new Error(`Cancel failed: ${String(error)}`);
    onError?.(normalizedError);
  }
}

export function resolveTerragonRuntimeLoadConfig({
  isAgentWorking,
  threadChatId,
  retryNonce = 0,
}: {
  isAgentWorking: boolean;
  threadChatId?: string;
  retryNonce?: number;
}): {
  resumeOnLoad: boolean;
  historyLoadKey: string;
  shouldApplyReplayCursor: boolean;
} {
  const mode = isAgentWorking ? "active" : "idle";
  const baseHistoryLoadKey = `${threadChatId ?? "unknown"}:${mode}`;
  return {
    resumeOnLoad: isAgentWorking,
    historyLoadKey:
      retryNonce > 0
        ? `${baseHistoryLoadKey}:retry-${retryNonce}`
        : baseHistoryLoadKey,
    shouldApplyReplayCursor: isAgentWorking,
  };
}

export function resolveTerragonThreadErrorProps({
  callerError,
  callerErrorType,
  callerErrorInfo,
  historyLoadError,
  runtimeError,
}: {
  callerError?: string | null;
  callerErrorType?: string | undefined;
  callerErrorInfo?: string | undefined;
  historyLoadError: string | null;
  runtimeError: string | null;
}): { errorType?: string; errorInfo?: string } {
  const hasCallerError =
    Boolean(callerError) ||
    callerErrorType !== undefined ||
    callerErrorInfo !== undefined;
  if (hasCallerError) {
    return {
      ...(callerErrorType !== undefined ? { errorType: callerErrorType } : {}),
      ...(callerErrorInfo !== undefined ? { errorInfo: callerErrorInfo } : {}),
    };
  }
  if (historyLoadError) {
    return {
      errorType: "history-load",
      errorInfo: historyLoadError,
    };
  }
  if (runtimeError) {
    return {
      errorType: "runtime",
      errorInfo: runtimeError,
    };
  }
  return {};
}

export type TerragonRuntimeSessionProps = {
  agent: HttpAgent;
  loadAgUiHistoryMessages: () => Promise<AgUiHistoryMessagesResult>;
  chatAgent: AIAgent;
  isAgentWorking: boolean;
  threadId: string;
  threadChatId?: string;
  callerError?: string | null;
  callerErrorType?: string;
  callerErrorInfo?: string;
  runtimeQueue?: UseAgUiRuntimeOptions["queue"];
  children: (props: {
    errorInfo?: string;
    errorType?: string;
    handleRetry?: () => Promise<void>;
    isRetrying?: boolean;
  }) => React.ReactNode;
};

export function TerragonRuntimeSession({
  agent,
  loadAgUiHistoryMessages,
  chatAgent,
  isAgentWorking,
  threadId,
  threadChatId,
  callerError,
  callerErrorType,
  callerErrorInfo,
  runtimeQueue,
  children,
}: TerragonRuntimeSessionProps) {
  const showThinking = chatAgent === "claudeCode" || chatAgent === "codex";
  const [historyLoadErrorState, setHistoryLoadErrorState] = useState<{
    agent: HttpAgent;
    loadAgUiHistoryMessages: TerragonRuntimeSessionProps["loadAgUiHistoryMessages"];
    message: string;
  } | null>(null);
  const [runtimeErrorState, setRuntimeErrorState] = useState<{
    agent: HttpAgent;
    message: string;
  } | null>(null);
  const [runtimeRecoveryNonce, setRuntimeRecoveryNonce] = useState(0);
  const historyLoadError =
    historyLoadErrorState?.agent === agent &&
    historyLoadErrorState.loadAgUiHistoryMessages === loadAgUiHistoryMessages
      ? historyLoadErrorState.message
      : null;
  const runtimeError =
    runtimeErrorState?.agent === agent ? runtimeErrorState.message : null;
  const runtimeLoadConfig = useMemo(
    () =>
      resolveTerragonRuntimeLoadConfig({
        isAgentWorking,
        threadChatId,
        retryNonce: runtimeRecoveryNonce,
      }),
    [isAgentWorking, threadChatId, runtimeRecoveryNonce],
  );
  const resumeOnLoad = runtimeLoadConfig.resumeOnLoad;
  const historyLoadKey = runtimeLoadConfig.historyLoadKey;
  const shouldApplyReplayCursor = runtimeLoadConfig.shouldApplyReplayCursor;

  const handleLocalRuntimeRetry = useCallback(async () => {
    setHistoryLoadErrorState(null);
    setRuntimeErrorState(null);
    setRuntimeRecoveryNonce((nonce) => nonce + 1);
  }, []);

  const loadHistoryMessages = useCallback(async () => {
    try {
      const history = await loadAgUiHistoryMessages();
      if (shouldApplyReplayCursor) {
        applyReplayCursorToAgent(agent, history.lastSeq);
      }
      setHistoryLoadErrorState(null);
      setRuntimeErrorState(null);
      return history.messages;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `History load failed: ${String(error)}`;
      setHistoryLoadErrorState({
        agent,
        loadAgUiHistoryMessages,
        message,
      });
      throw new TerragonHistoryLoadError(message);
    }
  }, [agent, loadAgUiHistoryMessages, shouldApplyReplayCursor]);

  const handleRuntimeError = useCallback(
    (error: Error) => {
      if (error instanceof TerragonHistoryLoadError) {
        setHistoryLoadErrorState({
          agent,
          loadAgUiHistoryMessages,
          message: error.message,
        });
        return;
      }
      setRuntimeErrorState({ agent, message: error.message });
    },
    [agent, loadAgUiHistoryMessages],
  );

  const history = useMemo(
    () =>
      createAgUiHistoryAdapter(
        async () => {
          try {
            return await loadHistoryMessages();
          } catch (error) {
            const normalizedError =
              error instanceof Error
                ? error
                : new Error(`History load failed: ${String(error)}`);
            handleRuntimeError(normalizedError);
            return [];
          }
        },
        { resumeOnLoad },
      ),
    [handleRuntimeError, loadHistoryMessages, resumeOnLoad],
  );

  const runtimeOptions = useMemo<UseAgUiRuntimeOptions>(
    () => ({
      agent,
      showThinking,
      onError: handleRuntimeError,
      ...(threadChatId && {
        onCancel: () => {
          void postTerragonCancel({
            threadId,
            threadChatId,
            onError: handleRuntimeError,
          });
        },
      }),
      adapters: {
        history,
      },
      historyLoadKey,
      externalMessagesStrategy: "merge-after-local-mutations",
      ...(runtimeQueue ? { queue: runtimeQueue } : {}),
    }),
    [
      agent,
      handleRuntimeError,
      history,
      showThinking,
      historyLoadKey,
      threadId,
      threadChatId,
      runtimeQueue,
    ],
  );

  const runtime = useAgUiRuntime(runtimeOptions);
  const resolvedErrorProps = resolveTerragonThreadErrorProps({
    callerError,
    callerErrorType,
    callerErrorInfo,
    historyLoadError,
    runtimeError,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children({
        errorInfo: resolvedErrorProps.errorInfo,
        errorType: resolvedErrorProps.errorType,
        handleRetry:
          historyLoadError || runtimeError
            ? handleLocalRuntimeRetry
            : undefined,
        isRetrying: historyLoadError || runtimeError ? false : undefined,
      })}
    </AssistantRuntimeProvider>
  );
}
