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
 * Latest well-formed run for a thread chat, derived in-memory from the durable
 * envelope log the projector already fetched. Mirrors
 * `getLatestRunIdForThreadChat`: among runs that carry a `RUN_STARTED` marker
 * (AG-UI-native rows and canonical `run-started` rows both map to
 * `EventType.RUN_STARTED`), pick the one with the greatest max(seq). Returns
 * null when no run is eligible (zero envelopes, or every run is legacy-shaped
 * without a start marker). Seq is thread-chat-monotonic and non-interleaving
 * across runs, so max-seq selection identifies the latest run identically to
 * the SQL version.
 */
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

export async function projectThreadHistory(params: {
  threadChatId: string;
  userId: string;
  dbMessages: readonly DBMessage[];
}): Promise<ThreadHistoryProjection> {
  const { threadChatId, userId, dbMessages } = params;

  // Stage 1: durable envelope log. It doubles as the source of the latest
  // runId, replacing the former standalone getLatestRunIdForThreadChat scan.
  const envelopes = await getAgUiEventEnvelopesForThreadChat({
    db,
    threadChatId,
  });

  // Stage 2: authoritative liveness for the run derived from stage 1. This is
  // the only remaining sequential dependency — the run-context read needs the
  // derived runId, so the two stages cannot be parallelized.
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
