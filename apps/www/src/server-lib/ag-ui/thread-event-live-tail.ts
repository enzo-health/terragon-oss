import type { BaseEvent } from "@ag-ui/core";
import type { DB } from "@terragon/shared/db";
import {
  getAgUiEventEnvelopesForThreadChat,
  getLatestRunIdForThreadChat,
} from "@terragon/shared/model/agent-event-log";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { recordAgentTraceSpan } from "@/lib/agent-trace";
import {
  isTerminalRunEventType,
  type ReplayEntry,
  repairReplayTextMessageLifecycles,
  toReplayEntries,
} from "@/server-lib/ag-ui/ag-ui-replay-planner";
import { buildTerminalEventFromRunContext } from "@/server-lib/ag-ui/terminal-event-synthesizer";

export type LiveTailSseSession = {
  readonly closed: boolean;
  readonly hasEmittedAgUiDataEvent: boolean;
  lastDeliveredSeq: number | null;
  readonly replayCursorSeq: number | null;
  resolvedRunId: string | null;
  frameResumeReplayEntries(replayEntries: ReplayEntry[]): boolean;
  emitReplayEntry(entry: ReplayEntry): boolean;
  emitAgUiEvent(event: BaseEvent, seq: number | null): boolean;
  close(
    reason:
      | "terminal_event"
      | "durable_terminal_idle"
      | "durable_terminal_after_xread_error",
  ): void;
};

export async function replayDurableEventsAfterCursor(params: {
  db: DB;
  sse: LiveTailSseSession;
  threadId: string;
  threadChatId: string;
}): Promise<boolean> {
  const { db, sse, threadId, threadChatId } = params;
  let replayEnvelopes: Awaited<
    ReturnType<typeof getAgUiEventEnvelopesForThreadChat>
  >;
  try {
    replayEnvelopes = await getAgUiEventEnvelopesForThreadChat({
      db,
      threadChatId,
      afterSeq: sse.lastDeliveredSeq ?? undefined,
    });
  } catch (error) {
    recordAgentTraceSpan({
      traceId: sse.resolvedRunId ?? threadChatId,
      name: "server.agui.live_tail.replay_failed",
      attributes: {
        threadId,
        threadChatId,
        runId: sse.resolvedRunId,
        afterSeq: sse.lastDeliveredSeq,
        errorName: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    console.warn(
      "[ag-ui] durable catch-up replay failed during live-tail; continuing",
      { threadId, threadChatId, runId: sse.resolvedRunId },
      error,
    );
    return false;
  }

  if (replayEnvelopes.length === 0) {
    return false;
  }

  const replayEntries = toReplayEntries(replayEnvelopes, null);
  if (!sse.frameResumeReplayEntries(replayEntries)) {
    return true;
  }
  const repairedReplayEntries = !sse.hasEmittedAgUiDataEvent
    ? repairReplayTextMessageLifecycles(replayEntries)
    : replayEntries;
  let emittedReplayEntry = false;
  for (const entry of repairedReplayEntries) {
    if (!sse.emitReplayEntry(entry)) {
      return true;
    }
    emittedReplayEntry = true;
    if (isTerminalRunEventType(entry.event.type)) {
      sse.close("terminal_event");
      return true;
    }
  }
  return emittedReplayEntry;
}

export async function reconcileActiveRunFromDurable(params: {
  db: DB;
  sse: LiveTailSseSession;
  threadId: string;
  threadChatId: string;
  runId: string;
  userId: string;
  phase: "idle" | "xread_error";
  cause?: unknown;
}): Promise<boolean> {
  const { db, sse, threadId, threadChatId, runId, userId, phase, cause } =
    params;
  try {
    const runContext = await getAgentRunContextByRunId({
      db,
      runId,
      userId,
    });
    const terminalEvent = buildTerminalEventFromRunContext({
      runId,
      runContext,
      threadId,
    });
    if (terminalEvent !== null) {
      await replayDurableEventsAfterCursor({ db, sse, threadId, threadChatId });
      if (sse.closed) {
        return true;
      }
      if (!sse.emitAgUiEvent(terminalEvent, null)) {
        return true;
      }
      sse.close(
        phase === "idle"
          ? "durable_terminal_idle"
          : "durable_terminal_after_xread_error",
      );
      return true;
    }
    await replayDurableEventsAfterCursor({ db, sse, threadId, threadChatId });
    return sse.closed;
  } catch (error) {
    const swallowed = cause ?? error;
    recordAgentTraceSpan({
      traceId: runId,
      name: "server.agui.live_tail.run_lookup_failed",
      attributes: {
        lookup: "run_context",
        phase,
        threadId,
        threadChatId,
        runId,
        errorName: swallowed instanceof Error ? swallowed.name : "unknown",
        errorMessage:
          swallowed instanceof Error ? swallowed.message : String(swallowed),
      },
    });
    console.warn(
      "[ag-ui] durable run status check failed during live-tail; continuing",
      { phase, threadId, threadChatId, runId },
      cause ?? error,
    );
  }
  return false;
}

export async function discoverRunFromDurableLog(params: {
  db: DB;
  sse: LiveTailSseSession;
  threadId: string;
  threadChatId: string;
}): Promise<{ discoveredRunId: string | null; replayed: boolean }> {
  const { db, sse, threadId, threadChatId } = params;
  let latestRunId: string | null = null;
  try {
    latestRunId = await getLatestRunIdForThreadChat({
      db,
      threadChatId,
    });
  } catch (error) {
    recordAgentTraceSpan({
      traceId: sse.resolvedRunId ?? threadChatId,
      name: "server.agui.live_tail.run_lookup_failed",
      attributes: {
        lookup: "latest_run",
        threadId,
        threadChatId,
        resolvedRunId: sse.resolvedRunId,
        errorName: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    console.warn(
      "[ag-ui] latest-run discovery failed during empty live-tail; continuing",
      { threadId, threadChatId },
      error,
    );
    return { discoveredRunId: null, replayed: false };
  }
  if (latestRunId === null) {
    return { discoveredRunId: null, replayed: false };
  }

  sse.resolvedRunId = latestRunId;
  const replayed = await replayDurableEventsAfterCursor({
    db,
    sse,
    threadId,
    threadChatId,
  });
  return { discoveredRunId: latestRunId, replayed };
}
