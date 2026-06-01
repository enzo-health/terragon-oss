import type { BaseEvent } from "@ag-ui/core";
import {
  getAgUiEventEnvelopesForThreadChat,
  getLatestRunIdForThreadChat,
  isTerminalAgentRunStatus,
} from "@terragon/shared/model/agent-event-log";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import type { DB } from "@terragon/shared/db";
import { buildRunTerminalAgUi } from "@/server-lib/ag-ui-publisher";
import {
  isTerminalRunEventType,
  repairReplayTextMessageLifecycles,
  type ReplayEntry,
  toReplayEntries,
} from "@/server-lib/ag-ui/ag-ui-replay-planner";

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
  const repairedReplayEntries =
    sse.replayCursorSeq !== null && !sse.hasEmittedAgUiDataEvent
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
    if (runContext !== null && isTerminalAgentRunStatus(runContext.status)) {
      await replayDurableEventsAfterCursor({ db, sse, threadId, threadChatId });
      if (sse.closed) {
        return true;
      }
      const terminalEvent = buildRunTerminalAgUi({
        threadId,
        runId,
        daemonRunStatus: runContext.status,
        errorMessage: runContext.failureTerminalReason ?? null,
        errorCode: runContext.failureCategory ?? null,
      });
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
