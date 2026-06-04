import type { DBMessage } from "@terragon/shared";
import {
  getAgUiEventEnvelopesForThreadChat,
  getLatestRunIdForThreadChat,
  isTerminalAgentRunStatus,
} from "@terragon/shared/model/agent-event-log";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { db } from "@/lib/db";
import {
  dropEventsAfterTerminalUntilNextRun,
  type ReplayEntry,
  toReplayEntriesWithoutTerminalFilter,
} from "@/server-lib/ag-ui/ag-ui-replay-planner";
import { mergeMissingDbUserMessagesIntoHistory } from "@/server-lib/ag-ui/ag-ui-user-message-backfill";
import { getDurableAgUiHistoryItemsFromEvents } from "@/server-lib/ag-ui/durable-history-builder";

export type ThreadHistoryProjection = {
  messages: unknown[];
  lastSeq: number;
  lastCursor?: {
    seq: number;
    projectionIndex: number;
  };
  runActive: boolean;
  activeRunId: string | null;
};

/**
 * Authoritative run liveness from the durable run context — the same check the
 * SSE GET path uses (getAgentRunContextByRunId + isTerminalAgentRunStatus).
 * Best-effort: any failure degrades to runActive:false so the history
 * projection never fails on a liveness lookup; the client then falls back to
 * the isAgentWorking hint.
 */
async function resolveServerRunLiveness(params: {
  threadChatId: string;
  userId: string;
}): Promise<{ runActive: boolean; activeRunId: string | null }> {
  try {
    const latestRunId = await getLatestRunIdForThreadChat({
      db,
      threadChatId: params.threadChatId,
    });
    if (latestRunId === null) {
      return { runActive: false, activeRunId: null };
    }
    const runContext = await getAgentRunContextByRunId({
      db,
      runId: latestRunId,
      userId: params.userId,
    });
    if (runContext === null) {
      return { runActive: false, activeRunId: latestRunId };
    }
    return {
      runActive: !isTerminalAgentRunStatus(runContext.status),
      activeRunId: latestRunId,
    };
  } catch (error) {
    console.warn(
      "[ag-ui] history run-liveness lookup failed; defaulting runActive=false",
      { threadChatId: params.threadChatId },
      error,
    );
    return { runActive: false, activeRunId: null };
  }
}

export async function projectThreadHistory(params: {
  threadChatId: string;
  userId: string;
  dbMessages: readonly DBMessage[];
}): Promise<ThreadHistoryProjection> {
  const { threadChatId, userId, dbMessages } = params;

  const liveness = await resolveServerRunLiveness({ threadChatId, userId });

  const envelopes = await getAgUiEventEnvelopesForThreadChat({
    db,
    threadChatId,
  });
  const historyEntries = dropEventsAfterTerminalUntilNextRun(
    toReplayEntriesWithoutTerminalFilter(envelopes, null),
    { keepInterRunUserAndSystemSnapshots: true },
  );
  const historyEvents = historyEntries.map((entry: ReplayEntry) => entry.event);
  const history = getDurableAgUiHistoryItemsFromEvents(historyEvents);
  const messages = mergeMissingDbUserMessagesIntoHistory({
    historyItems: history.items,
    dbMessages,
  });
  const includedCursor =
    history.lastSeqOffset >= 0
      ? historyEntries[history.lastSeqOffset]
      : undefined;

  return {
    messages,
    lastSeq: includedCursor?.seq ?? -1,
    lastCursor:
      includedCursor?.seq != null &&
      includedCursor.identity?.projectionIndex !== undefined
        ? {
            seq: includedCursor.seq,
            projectionIndex: includedCursor.identity.projectionIndex,
          }
        : undefined,
    runActive: liveness.runActive,
    activeRunId: liveness.activeRunId,
  };
}
