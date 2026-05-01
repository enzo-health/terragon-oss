"use client";

import type { HttpAgent } from "@ag-ui/client";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useCallback, useMemo, useState } from "react";
import type { AgUiHistoryMessagesResult } from "@/lib/ag-ui-history-types";
import { useTerragonRuntime } from "../assistant-runtime";
import { TerragonThreadErrorBoundary } from "./terragon-thread-error-boundary";
import {
  TerragonThreadRuntimeContent,
  type TerragonThreadRuntimeContentProps,
} from "./terragon-thread-runtime-content";
import { shouldSuppressPreStartLifecycleFooter } from "./working-footer-freshness";

export { shouldSuppressPreStartLifecycleFooter };
export { TerragonThreadErrorBoundary };

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

type TerragonThreadProps = TerragonThreadRuntimeContentProps & {
  agent: HttpAgent;
  loadAgUiHistoryMessages: () => Promise<AgUiHistoryMessagesResult>;
};

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

export function TerragonThread({
  agent,
  loadAgUiHistoryMessages,
  onCancel,
  chatAgent,
  ...contentProps
}: TerragonThreadProps) {
  const showThinking = chatAgent === "claudeCode" || chatAgent === "codex";
  const [historyLoadErrorState, setHistoryLoadErrorState] = useState<{
    agent: HttpAgent;
    loadAgUiHistoryMessages: TerragonThreadProps["loadAgUiHistoryMessages"];
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
        isAgentWorking: contentProps.isAgentWorking,
        threadChatId: contentProps.threadChatId,
        retryNonce: runtimeRecoveryNonce,
      }),
    [
      contentProps.isAgentWorking,
      contentProps.threadChatId,
      runtimeRecoveryNonce,
    ],
  );

  const handleLocalRuntimeRetry = useCallback(async () => {
    setHistoryLoadErrorState(null);
    setRuntimeErrorState(null);
    setRuntimeRecoveryNonce((nonce) => nonce + 1);
  }, []);

  const runtimeConfig = useMemo(
    () => ({
      agent,
      loadHistoryMessages: async () => {
        try {
          const history = await loadAgUiHistoryMessages();
          if (runtimeLoadConfig.shouldApplyReplayCursor) {
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
      },
      onError: (error: Error) => {
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
      showThinking,
      onCancel,
      resumeOnLoad: runtimeLoadConfig.resumeOnLoad,
      historyLoadKey: runtimeLoadConfig.historyLoadKey,
      threadId: contentProps.thread.id,
      threadChatId: contentProps.threadChatId,
    }),
    [
      agent,
      loadAgUiHistoryMessages,
      showThinking,
      onCancel,
      runtimeLoadConfig,
      contentProps.thread.id,
      contentProps.threadChatId,
    ],
  );

  const runtime = useTerragonRuntime(runtimeConfig);
  const resolvedErrorProps = resolveTerragonThreadErrorProps({
    callerError: contentProps.error,
    callerErrorType: contentProps.errorType,
    callerErrorInfo: contentProps.errorInfo,
    historyLoadError,
    runtimeError,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TerragonThreadRuntimeContent
        {...contentProps}
        chatAgent={chatAgent}
        onCancel={onCancel}
        errorInfo={resolvedErrorProps.errorInfo}
        errorType={resolvedErrorProps.errorType}
        handleRetry={
          historyLoadError || runtimeError
            ? handleLocalRuntimeRetry
            : contentProps.handleRetry
        }
        isRetrying={
          historyLoadError || runtimeError ? false : contentProps.isRetrying
        }
      />
    </AssistantRuntimeProvider>
  );
}
