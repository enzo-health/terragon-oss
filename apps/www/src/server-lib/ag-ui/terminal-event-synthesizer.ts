import type { BaseEvent } from "@ag-ui/core";
import type { AgUiEventEnvelope } from "@terragon/shared/model/agent-event-log";
import { isTerminalAgentRunStatus } from "@terragon/shared/model/agent-event-log";
import type { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { deriveChatFailureThreadErrorType } from "@terragon/shared/runtime/chat-failure";
import {
  isTerminalRunEventType,
  type ReplayEntry,
} from "@/server-lib/ag-ui/ag-ui-replay-planner";
import { buildRunTerminalAgUi } from "@/server-lib/ag-ui-publisher";

type RunContext = Awaited<ReturnType<typeof getAgentRunContextByRunId>>;

export function buildTerminalEventFromRunContext(params: {
  runId: string | null;
  runContext: RunContext;
  threadId: string;
}): BaseEvent | null {
  const { runId, runContext, threadId } = params;
  if (
    runId === null ||
    runContext === null ||
    !isTerminalAgentRunStatus(runContext.status)
  ) {
    return null;
  }
  return buildRunTerminalAgUi({
    threadId,
    runId,
    daemonRunStatus: runContext.status,
    errorMessage: runContext.failureTerminalReason ?? null,
    errorCode: runContext.failureTerminalReason
      ? deriveChatFailureThreadErrorType(runContext.failureTerminalReason)
      : null,
  });
}

export type TerminalSynthesisResult = {
  /** Whether the replay envelopes already contain a terminal event for the run. */
  hasTerminalEvent: boolean;
  /** A synthetic terminal entry to append, or null if no synthesis needed. */
  syntheticTerminalEntry: ReplayEntry | null;
};

/**
 * Check whether a run already has a terminal event in the durable replay
 * envelopes and, if not, synthesize one from the run's durable status.
 *
 * This handles the case where Redis live-tail misses the daemon's terminal
 * marker but the durable run status has already flipped to terminal. The
 * synthesized entry is appended after the replay entries so the client
 * receives a clean terminal signal.
 */
export function synthesizeTerminalEntry(params: {
  runId: string | null;
  envelopes: readonly AgUiEventEnvelope[];
  runContext: RunContext;
  threadId: string;
}): TerminalSynthesisResult {
  const { runId, envelopes, runContext, threadId } = params;

  const hasTerminalEvent =
    runId === null
      ? false
      : envelopes.some(
          (entry) =>
            entry.runId === runId && isTerminalRunEventType(entry.payload.type),
        );

  if (!hasTerminalEvent) {
    const terminalEvent = buildTerminalEventFromRunContext({
      runId,
      runContext,
      threadId,
    });
    if (terminalEvent !== null) {
      return {
        hasTerminalEvent,
        syntheticTerminalEntry: { seq: null, event: terminalEvent },
      };
    }
  }

  return {
    hasTerminalEvent,
    syntheticTerminalEntry: null,
  };
}
