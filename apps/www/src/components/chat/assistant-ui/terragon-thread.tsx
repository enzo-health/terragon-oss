"use client";

import type { HttpAgent } from "@ag-ui/client";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useMemo, useState } from "react";
import type { AgUiHistoryMessagesResult } from "../ag-ui-history-types";
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

type TerragonThreadProps = TerragonThreadRuntimeContentProps & {
  agent: HttpAgent;
  loadAgUiHistoryMessages: () => Promise<AgUiHistoryMessagesResult>;
};

export function resolveTerragonThreadErrorProps({
  callerError,
  callerErrorType,
  callerErrorInfo,
  historyLoadError,
}: {
  callerError?: string | null;
  callerErrorType?: string | undefined;
  callerErrorInfo?: string | undefined;
  historyLoadError: string | null;
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
  const historyLoadError =
    historyLoadErrorState?.agent === agent &&
    historyLoadErrorState.loadAgUiHistoryMessages === loadAgUiHistoryMessages
      ? historyLoadErrorState.message
      : null;

  const runtimeConfig = useMemo(
    () => ({
      agent,
      loadHistoryMessages: async () => {
        const history = await loadAgUiHistoryMessages();
        applyReplayCursorToAgent(agent, history.lastSeq);
        setHistoryLoadErrorState(null);
        return history.messages;
      },
      onError: (error: Error) => {
        setHistoryLoadErrorState({
          agent,
          loadAgUiHistoryMessages,
          message: error.message,
        });
      },
      showThinking,
      onCancel,
    }),
    [agent, loadAgUiHistoryMessages, showThinking, onCancel],
  );

  const runtime = useTerragonRuntime(runtimeConfig);
  const resolvedErrorProps = resolveTerragonThreadErrorProps({
    callerError: contentProps.error,
    callerErrorType: contentProps.errorType,
    callerErrorInfo: contentProps.errorInfo,
    historyLoadError,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TerragonThreadRuntimeContent
        {...contentProps}
        chatAgent={chatAgent}
        onCancel={onCancel}
        errorInfo={resolvedErrorProps.errorInfo}
        errorType={resolvedErrorProps.errorType}
      />
    </AssistantRuntimeProvider>
  );
}
