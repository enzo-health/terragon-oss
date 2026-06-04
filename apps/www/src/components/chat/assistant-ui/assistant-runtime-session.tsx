"use client";

import type { HttpAgent } from "@ag-ui/client";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  type UseAgUiRuntimeOptions,
  useAgUiRuntime,
} from "@assistant-ui/react-ag-ui";
import type { AIAgent } from "@terragon/agent/types";
import type { ThreadErrorType } from "@terragon/shared";
import { useCallback, useMemo, useState } from "react";
import type { AgUiReplayCursor } from "@/hooks/use-ag-ui-transport";
import type { AgUiHistoryMessagesResult } from "@/lib/ag-ui-history-types";
import { createAssistantHistoryHydrationAdapter } from "../assistant-history-hydration-adapter";
import { extractRuntimeErrorPayload } from "./runtime-error-classification";
import { resolveRuntimeResumePolicy } from "./runtime-resume-policy";

class AssistantHistoryLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantHistoryLoadError";
  }
}

async function postRuntimeCancel({
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

function resolveThreadRuntimeErrorProps({
  callerError,
  callerErrorType,
  callerErrorInfo,
  historyLoadError,
  runtimeError,
  runtimeErrorCode,
}: {
  callerError?: string | null;
  callerErrorType?: string | undefined;
  callerErrorInfo?: string | undefined;
  historyLoadError: string | null;
  runtimeError: string | null;
  runtimeErrorCode?: ThreadErrorType | null;
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
      errorType: runtimeErrorCode ?? "runtime",
      errorInfo: runtimeError,
    };
  }
  return {};
}

function AssistantRuntimeBoundary({
  runtimeOptions,
  children,
}: {
  runtimeOptions: UseAgUiRuntimeOptions;
  children: React.ReactNode;
}) {
  return (
    <AssistantRuntimeProviderBoundary runtimeOptions={runtimeOptions}>
      {children}
    </AssistantRuntimeProviderBoundary>
  );
}

function AssistantRuntimeProviderBoundary({
  runtimeOptions,
  children,
}: {
  runtimeOptions: UseAgUiRuntimeOptions;
  children: React.ReactNode;
}) {
  const runtime = useAgUiRuntime(runtimeOptions);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

export type AssistantRuntimeSessionProps = {
  agent: HttpAgent;
  loadAgUiHistoryMessages: () => Promise<AgUiHistoryMessagesResult>;
  chatAgent: AIAgent;
  isAgentWorking: boolean;
  threadId: string;
  threadChatId?: string;
  setReplayCursor: (cursor: AgUiReplayCursor | null) => void;
  onAppendRejected?: (rejection: {
    kind: "rejected" | "lock-held";
    clientSubmissionId: string | null;
  }) => void;
  callerError?: string | null;
  callerErrorType?: string;
  callerErrorInfo?: string;
  children: (props: {
    errorInfo?: string;
    errorType?: string;
    handleRetry?: () => Promise<void>;
    isRetrying?: boolean;
  }) => React.ReactNode;
};

export function AssistantRuntimeSession({
  agent,
  loadAgUiHistoryMessages,
  chatAgent,
  isAgentWorking,
  threadId,
  threadChatId,
  setReplayCursor,
  onAppendRejected,
  callerError,
  callerErrorType,
  callerErrorInfo,
  children,
}: AssistantRuntimeSessionProps) {
  const showThinking = chatAgent === "claudeCode" || chatAgent === "codex";
  const [historyLoadErrorState, setHistoryLoadErrorState] = useState<{
    agent: HttpAgent;
    loadAgUiHistoryMessages: AssistantRuntimeSessionProps["loadAgUiHistoryMessages"];
    message: string;
  } | null>(null);
  const [runtimeErrorState, setRuntimeErrorState] = useState<{
    agent: HttpAgent;
    message: string;
    code: ThreadErrorType | null;
  } | null>(null);
  const [runtimeRecoveryNonce, setRuntimeRecoveryNonce] = useState(0);
  const historyLoadError =
    historyLoadErrorState?.agent === agent &&
    historyLoadErrorState.loadAgUiHistoryMessages === loadAgUiHistoryMessages
      ? historyLoadErrorState.message
      : null;
  const runtimeError =
    runtimeErrorState?.agent === agent ? runtimeErrorState.message : null;
  const runtimeErrorCode =
    runtimeErrorState?.agent === agent ? runtimeErrorState.code : null;
  const runtimeResumePolicy = useMemo(
    () =>
      resolveRuntimeResumePolicy({
        isAgentWorking,
        threadChatId,
        retryNonce: runtimeRecoveryNonce,
      }),
    [isAgentWorking, threadChatId, runtimeRecoveryNonce],
  );

  const handleLocalRuntimeRetry = useCallback(async () => {
    setHistoryLoadErrorState(null);
    setRuntimeErrorState(null);
    setRuntimeRecoveryNonce((nonce) => nonce + 1);
  }, []);

  const loadHistoryMessages = useCallback(async () => {
    try {
      const history = await loadAgUiHistoryMessages();
      if (runtimeResumePolicy.replayCursorAction === "apply-history-last-seq") {
        setReplayCursor(
          history.lastCursor ?? { seq: history.lastSeq, projectionIndex: null },
        );
      } else {
        setReplayCursor(null);
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
      throw new AssistantHistoryLoadError(message);
    }
  }, [
    agent,
    loadAgUiHistoryMessages,
    runtimeResumePolicy.replayCursorAction,
    setReplayCursor,
  ]);

  const handleRuntimeError = useCallback(
    (error: Error) => {
      if (error instanceof AssistantHistoryLoadError) {
        setHistoryLoadErrorState({
          agent,
          loadAgUiHistoryMessages,
          message: error.message,
        });
        return;
      }
      const payload = extractRuntimeErrorPayload(error);
      // A `RUN_STARTED`-while-active race (and the symmetric post-finish tail
      // race) is a benign client-side lifecycle hiccup — the run is still
      // streaming, nothing failed. Swallow it; real failures still surface.
      if (payload.kind === "transient-lifecycle") {
        return;
      }
      if (payload.kind === "lock-held") {
        onAppendRejected?.({
          kind: "lock-held",
          clientSubmissionId: payload.clientSubmissionId,
        });
        setRuntimeErrorState({ agent, message: error.message, code: null });
        return;
      }
      // run-failure | transport both map to a non-lock "rejected" for the
      // reducer; only run-failure carries a typed ThreadErrorType for copy.
      onAppendRejected?.({
        kind: "rejected",
        clientSubmissionId: payload.clientSubmissionId,
      });
      setRuntimeErrorState({
        agent,
        message: payload.info,
        code: payload.kind === "run-failure" ? payload.code : null,
      });
    },
    [agent, loadAgUiHistoryMessages, onAppendRejected],
  );

  const history = useMemo(
    () =>
      createAssistantHistoryHydrationAdapter(
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
        { mode: runtimeResumePolicy.historyMode },
      ),
    [handleRuntimeError, loadHistoryMessages, runtimeResumePolicy.historyMode],
  );

  const runtimeOptions = useMemo<UseAgUiRuntimeOptions>(
    () => ({
      agent,
      showThinking,
      onError: handleRuntimeError,
      historyLoadKey: runtimeResumePolicy.historyLoadKey,
      externalMessagesStrategy: "merge-after-local-mutations",
      ...(threadChatId && {
        onCancel: () => {
          void postRuntimeCancel({
            threadId,
            threadChatId,
            onError: handleRuntimeError,
          });
        },
      }),
      adapters: {
        history,
      },
    }),
    [
      agent,
      handleRuntimeError,
      history,
      runtimeResumePolicy.historyLoadKey,
      showThinking,
      threadId,
      threadChatId,
    ],
  );

  const resolvedErrorProps = resolveThreadRuntimeErrorProps({
    callerError,
    callerErrorType,
    callerErrorInfo,
    historyLoadError,
    runtimeError,
    runtimeErrorCode,
  });

  return (
    <AssistantRuntimeBoundary runtimeOptions={runtimeOptions}>
      {children({
        errorInfo: resolvedErrorProps.errorInfo,
        errorType: resolvedErrorProps.errorType,
        handleRetry:
          historyLoadError || runtimeError
            ? handleLocalRuntimeRetry
            : undefined,
        isRetrying: historyLoadError || runtimeError ? false : undefined,
      })}
    </AssistantRuntimeBoundary>
  );
}
