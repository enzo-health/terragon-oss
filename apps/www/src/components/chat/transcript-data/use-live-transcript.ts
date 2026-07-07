"use client";

import type { AbstractAgent } from "@ag-ui/client";
import { EventType, type RunErrorEvent } from "@ag-ui/core";
import type { ThreadErrorType } from "@terragon/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgUiReplayCursor } from "@/hooks/use-ag-ui-transport";
import type { AgUiHistoryMessagesResult } from "@/lib/ag-ui-history-types";
import { encodeRunMetadata } from "@/lib/run-metadata";
import {
  extractRuntimeErrorPayload,
  isTransientRunLifecycleError,
} from "./runtime-error-classification";
import { TranscriptStore } from "../transcript-store";
import { hydrateTranscriptFromHistory } from "./hydrate-history";

export type TranscriptAppendRejection = {
  kind: "rejected" | "lock-held";
  clientSubmissionId: string | null;
};

type TransportError = { message: string; code: ThreadErrorType | null };

export type LiveTranscript = {
  readonly store: TranscriptStore;
  readonly isHydrating: boolean;
  readonly errorType?: string;
  readonly errorInfo?: string;
  readonly handleRetry?: () => Promise<void>;
  readonly isRetrying?: boolean;
};

export type UseLiveTranscriptArgs = {
  agent: AbstractAgent | null;
  loadHistory: () => Promise<AgUiHistoryMessagesResult>;
  isAgentWorking: boolean;
  setReplayCursor: (cursor: AgUiReplayCursor | null) => void;
  onAppendRejected?: (rejection: TranscriptAppendRejection) => void;
  callerError?: string | null;
  callerErrorType?: string;
  callerErrorInfo?: string;
  serverRetry: () => Promise<void>;
  isServerRetrying: boolean;
};

/**
 * Whether the resume SSE stream should be opened after a history load. Opens
 * when the server-authoritative run context reports a live run OR the client
 * status projection says the agent is working. The server signal is primary:
 * it opens the stream even when the client `isAgentWorking` is stale-false
 * (the deadlock class the server-authoritative liveness fix targets).
 */
export function shouldOpenResumeStream({
  runActive,
  isAgentWorking,
}: {
  runActive?: boolean;
  isAgentWorking: boolean;
}): boolean {
  return runActive === true || isAgentWorking;
}

// The resume connect POSTs an explicit resume intent so the server frames it as
// a live-tail subscription (never a follow-up append), regardless of whether a
// replay cursor is present yet on the first connect.
const RESUME_FORWARDED_PROPS = {
  runConfig: encodeRunMetadata({
    selectedModel: null,
    permissionMode: undefined,
    intent: "resume",
  }),
};

const MAX_RESUME_RECONNECT_ATTEMPTS = 3;
const RESUME_RECONNECT_BASE_DELAY_MS = 300;

function resumeReconnectDelayMs(priorFailures: number): number {
  return RESUME_RECONNECT_BASE_DELAY_MS * 2 ** (priorFailures - 1);
}

export function useLiveTranscript({
  agent,
  loadHistory,
  isAgentWorking,
  setReplayCursor,
  onAppendRejected,
  callerError,
  callerErrorType,
  callerErrorInfo,
  serverRetry,
  isServerRetrying,
}: UseLiveTranscriptArgs): LiveTranscript {
  const storeRef = useRef<TranscriptStore | null>(null);
  if (storeRef.current === null) storeRef.current = new TranscriptStore();
  const store = storeRef.current;
  const runIdRef = useRef<string | null>(null);
  const lastRunErrorRef = useRef<{
    code: string | null;
    message: string;
  } | null>(null);
  const [isHydrating, setIsHydrating] = useState(true);
  const [retryNonce, setRetryNonce] = useState(0);
  const [transportError, setTransportError] = useState<TransportError | null>(
    null,
  );

  const resumeFailureCountRef = useRef(0);
  const lastTransportErrorRef = useRef<TransportError | null>(null);
  const connectAgentRef = useRef<AbstractAgent | null>(null);
  const isAgentWorkingRef = useRef(isAgentWorking);
  isAgentWorkingRef.current = isAgentWorking;
  const onAppendRejectedRef = useRef(onAppendRejected);
  onAppendRejectedRef.current = onAppendRejected;
  const setReplayCursorRef = useRef(setReplayCursor);
  setReplayCursorRef.current = setReplayCursor;

  const classifyTransportError = useCallback((error: Error) => {
    const captured = lastRunErrorRef.current;
    lastRunErrorRef.current = null;
    const capturedTypedCode =
      captured !== null && captured.message === error.message
        ? captured.code
        : null;
    const payload = extractRuntimeErrorPayload(error, capturedTypedCode);
    // A `RUN_STARTED`-while-active race (and the symmetric post-finish tail
    // race) is a benign client lifecycle hiccup — the run is still streaming.
    if (payload.kind === "transient-lifecycle") return;
    if (payload.kind === "lock-held") {
      onAppendRejectedRef.current?.({
        kind: "lock-held",
        clientSubmissionId: payload.clientSubmissionId,
      });
      const next = { message: error.message, code: null };
      lastTransportErrorRef.current = next;
      setTransportError(next);
      return;
    }
    onAppendRejectedRef.current?.({
      kind: "rejected",
      clientSubmissionId: payload.clientSubmissionId,
    });
    const next = {
      message: payload.info,
      code: payload.kind === "run-failure" ? payload.code : null,
    };
    lastTransportErrorRef.current = next;
    setTransportError(next);
  }, []);

  useEffect(() => {
    void retryNonce;
    if (!agent) return;
    if (connectAgentRef.current !== agent) {
      connectAgentRef.current = agent;
      resumeFailureCountRef.current = 0;
      lastTransportErrorRef.current = null;
    }
    store.reset();
    runIdRef.current = null;
    lastRunErrorRef.current = null;
    setIsHydrating(true);
    setTransportError(null);

    const subscription = agent.subscribe({
      onEvent: ({ event }) => {
        try {
          if (event.type === EventType.RUN_STARTED) {
            const runId = Reflect.get(event, "runId");
            if (typeof runId === "string" && runId.length > 0) {
              runIdRef.current = runId;
            }
          } else if (event.type === EventType.RUN_ERROR) {
            const runError = event as RunErrorEvent;
            lastRunErrorRef.current = {
              code:
                typeof runError.code === "string" && runError.code.length > 0
                  ? runError.code
                  : null,
              message: runError.message,
            };
          }
          store.apply({ payload: event, runId: runIdRef.current });
        } catch {}
      },
    });

    let cancelled = false;

    const connectResume = async () => {
      const priorFailures = resumeFailureCountRef.current;
      if (priorFailures >= MAX_RESUME_RECONNECT_ATTEMPTS) {
        if (lastTransportErrorRef.current !== null) {
          setTransportError(lastTransportErrorRef.current);
        }
        return;
      }
      if (priorFailures > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, resumeReconnectDelayMs(priorFailures)),
        );
        if (cancelled) return;
      }
      try {
        await agent.runAgent({ forwardedProps: RESUME_FORWARDED_PROPS });
        resumeFailureCountRef.current = 0;
      } catch (error) {
        if (cancelled) return;
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        if (!isTransientRunLifecycleError(normalized)) {
          resumeFailureCountRef.current += 1;
        }
        classifyTransportError(normalized);
      }
    };

    loadHistory()
      .then((result) => {
        if (cancelled) return;
        if (result.activeRunId) runIdRef.current = result.activeRunId;
        hydrateTranscriptFromHistory(store, result);
        setReplayCursorRef.current(
          result.lastCursor ?? { seq: result.lastSeq, projectionIndex: null },
        );
        if (
          shouldOpenResumeStream({
            runActive: result.runActive,
            isAgentWorking: isAgentWorkingRef.current,
          })
        ) {
          void connectResume();
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setTransportError({
          message:
            error instanceof Error
              ? error.message
              : `History load failed: ${String(error)}`,
          code: null,
        });
      })
      .finally(() => {
        if (!cancelled) setIsHydrating(false);
      });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
      try {
        agent.abortRun();
      } catch {}
    };
  }, [agent, loadHistory, store, retryNonce, classifyTransportError]);

  const retryTransport = useCallback(async () => {
    resumeFailureCountRef.current = 0;
    lastTransportErrorRef.current = null;
    setTransportError(null);
    setRetryNonce((nonce) => nonce + 1);
  }, []);

  const errorProps = useMemo<
    Pick<
      LiveTranscript,
      "errorType" | "errorInfo" | "handleRetry" | "isRetrying"
    >
  >(() => {
    const hasCallerError =
      Boolean(callerError) ||
      callerErrorType !== undefined ||
      callerErrorInfo !== undefined;
    if (hasCallerError) {
      return {
        ...(callerErrorType !== undefined
          ? { errorType: callerErrorType }
          : {}),
        ...(callerErrorInfo !== undefined
          ? { errorInfo: callerErrorInfo }
          : {}),
        handleRetry: serverRetry,
        isRetrying: isServerRetrying,
      };
    }
    if (transportError) {
      return {
        errorType: transportError.code ?? "runtime",
        errorInfo: transportError.message,
        handleRetry: retryTransport,
        isRetrying: false,
      };
    }
    return { handleRetry: serverRetry, isRetrying: isServerRetrying };
  }, [
    callerError,
    callerErrorType,
    callerErrorInfo,
    transportError,
    retryTransport,
    serverRetry,
    isServerRetrying,
  ]);

  return { store, isHydrating, ...errorProps };
}
