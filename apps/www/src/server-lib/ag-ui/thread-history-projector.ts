import { EventType } from "@ag-ui/core";
import type { DBMessage } from "@terragon/shared";
import {
  type AgUiEventEnvelope,
  getAgUiEventEnvelopesForThreadChat,
  isTerminalAgentRunStatus,
} from "@terragon/shared/model/agent-event-log";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { db } from "@/lib/db";
import {
  dropEventsAfterTerminalUntilNextRun,
  type ReplayEntry,
  toReplayEntriesWithoutTerminalFilter,
} from "@/server-lib/ag-ui/ag-ui-replay-planner";
import type { DurableAgUiHistoryItem } from "@/server-lib/ag-ui-side-effect-messages";
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

export type DurableThreadHistory = {
  historyItems: DurableAgUiHistoryItem[];
  lastSeq: number;
  lastCursor?: {
    seq: number;
    projectionIndex: number;
  };
  runActive: boolean;
  activeRunId: string | null;
};

export function deriveLatestRunIdFromEnvelopes(
  envelopes: readonly AgUiEventEnvelope[],
): string | null {
  const maxSeqByRun = new Map<string, number>();
  const startedRunIds = new Set<string>();
  for (const envelope of envelopes) {
    const prevMax = maxSeqByRun.get(envelope.runId);
    if (prevMax === undefined || envelope.seq > prevMax) {
      maxSeqByRun.set(envelope.runId, envelope.seq);
    }
    if (envelope.payload.type === EventType.RUN_STARTED) {
      startedRunIds.add(envelope.runId);
    }
  }

  let latestRunId: string | null = null;
  let latestMaxSeq = Number.NEGATIVE_INFINITY;
  for (const runId of startedRunIds) {
    const maxSeq = maxSeqByRun.get(runId) ?? Number.NEGATIVE_INFINITY;
    if (maxSeq > latestMaxSeq) {
      latestMaxSeq = maxSeq;
      latestRunId = runId;
    }
  }
  return latestRunId;
}

/**
 * Authoritative run liveness from the durable run context — the same check the
 * SSE GET path uses (getAgentRunContextByRunId + isTerminalAgentRunStatus).
 * Best-effort: any failure degrades to runActive:false so the history
 * projection never fails on a liveness lookup; the client then falls back to
 * the isAgentWorking hint.
 */
async function resolveServerRunLiveness(params: {
  latestRunId: string | null;
  userId: string;
  threadChatId: string;
}): Promise<{ runActive: boolean; activeRunId: string | null }> {
  if (params.latestRunId === null) {
    return { runActive: false, activeRunId: null };
  }
  try {
    const runContext = await getAgentRunContextByRunId({
      db,
      runId: params.latestRunId,
      userId: params.userId,
    });
    if (runContext === null) {
      return { runActive: false, activeRunId: params.latestRunId };
    }
    return {
      runActive: !isTerminalAgentRunStatus(runContext.status),
      activeRunId: params.latestRunId,
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

export async function buildDurableThreadHistory(params: {
  threadChatId: string;
  userId: string;
}): Promise<DurableThreadHistory> {
  const { threadChatId, userId } = params;

  const envelopes = await getAgUiEventEnvelopesForThreadChat({
    db,
    threadChatId,
  });

  const liveness = await resolveServerRunLiveness({
    latestRunId: deriveLatestRunIdFromEnvelopes(envelopes),
    userId,
    threadChatId,
  });

  const historyEntries = dropEventsAfterTerminalUntilNextRun(
    toReplayEntriesWithoutTerminalFilter(envelopes, null),
    { keepInterRunUserAndSystemSnapshots: true },
  );
  const historyEvents = historyEntries.map((entry: ReplayEntry) => entry.event);
  const history = getDurableAgUiHistoryItemsFromEvents(historyEvents);
  const includedCursor =
    history.lastSeqOffset >= 0
      ? historyEntries[history.lastSeqOffset]
      : undefined;

  return {
    historyItems: history.items,
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

export function finalizeThreadHistoryProjection(params: {
  durable: DurableThreadHistory;
  dbMessages: readonly DBMessage[];
}): ThreadHistoryProjection {
  const { durable, dbMessages } = params;
  const messages = mergeMissingDbUserMessagesIntoHistory({
    historyItems: durable.historyItems,
    dbMessages,
  });
  return {
    messages,
    lastSeq: durable.lastSeq,
    lastCursor: durable.lastCursor,
    runActive: durable.runActive,
    activeRunId: durable.activeRunId,
  };
}

export async function projectThreadHistory(params: {
  threadChatId: string;
  userId: string;
  dbMessages: readonly DBMessage[];
}): Promise<ThreadHistoryProjection> {
  const durable = await buildDurableThreadHistory({
    threadChatId: params.threadChatId,
    userId: params.userId,
  });
  return finalizeThreadHistoryProjection({
    durable,
    dbMessages: params.dbMessages,
  });
}
