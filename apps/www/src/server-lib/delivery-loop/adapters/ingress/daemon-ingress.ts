import type { DB } from "@terragon/shared/db";
import type { DeliverySignalSourceV3 } from "@terragon/shared/db/types";
import type {
  DeliverySignal,
  DaemonCompletionResult,
  DaemonFailure,
  DaemonProgress,
} from "@terragon/shared/delivery-loop/domain/signals";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";

// Raw daemon event payload (what the daemon HTTP endpoint receives)
export type DaemonEventPayload = {
  threadId: string;
  loopId: string;
  runId: string;
  status: "completed" | "failed" | "progress" | "stopped";
  headSha?: string | null;
  summary?: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  remainingTasks?: number;
  completedTasks?: number;
  totalTasks?: number;
  currentTask?: string | null;
};

export type DaemonEventResponse = {
  selfDispatch: Record<string, unknown> | null;
  workItemsScheduled: number;
};

function toV3SignalSource(
  source: DeliverySignal["source"],
): DeliverySignalSourceV3 {
  switch (source) {
    case "daemon":
    case "github":
    case "human":
    case "timer":
      return source;
    case "babysit":
      return "system";
  }
}

function serializeSignalForJournal(
  signal: DeliverySignal,
): Record<string, unknown> {
  return {
    source: signal.source,
    event: {
      ...signal.event,
    },
  };
}

function buildDaemonCanonicalCauseId(rawEvent: DaemonEventPayload): string {
  if (rawEvent.status === "progress") {
    return `daemon:${rawEvent.runId}:progress:${rawEvent.completedTasks ?? 0}:${rawEvent.totalTasks ?? 0}:${rawEvent.currentTask ?? "none"}`;
  }

  return `daemon:${rawEvent.runId}:${rawEvent.status}:${
    rawEvent.status === "completed" &&
    rawEvent.remainingTasks != null &&
    rawEvent.remainingTasks > 0
      ? "partial"
      : "terminal"
  }`;
}

export function normalizeDaemonEvent(raw: DaemonEventPayload): DeliverySignal {
  switch (raw.status) {
    case "completed": {
      const result: DaemonCompletionResult =
        raw.remainingTasks != null && raw.remainingTasks > 0
          ? {
              kind: "partial",
              headSha: raw.headSha ?? "",
              summary: raw.summary ?? "",
              remainingTasks: raw.remainingTasks,
            }
          : {
              kind: "success",
              headSha: raw.headSha ?? "",
              summary: raw.summary ?? "",
            };
      return {
        source: "daemon",
        event: { kind: "run_completed", runId: raw.runId, result },
      };
    }

    case "failed": {
      const failure: DaemonFailure =
        raw.exitCode != null
          ? {
              kind: "runtime_crash",
              exitCode: raw.exitCode,
              message: raw.errorMessage ?? "Unknown error",
            }
          : {
              kind: "runtime_crash",
              exitCode: null,
              message: raw.errorMessage ?? "Unknown error",
            };
      return {
        source: "daemon",
        event: { kind: "run_failed", runId: raw.runId, failure },
      };
    }

    case "stopped": {
      // User-initiated stop — map to human signal so the coordinator
      // transitions to "stopped" instead of retrying implementation.
      return {
        source: "human",
        event: { kind: "stop_requested", actorUserId: "daemon" },
      };
    }

    case "progress": {
      const progress: DaemonProgress = {
        completedTasks: raw.completedTasks ?? 0,
        totalTasks: raw.totalTasks ?? 0,
        currentTask: raw.currentTask ?? null,
      };
      return {
        source: "daemon",
        event: {
          kind: "progress_reported",
          runId: raw.runId,
          progress,
        },
      };
    }
  }
}

/**
 * Handle an inbound daemon event: normalize to a typed signal
 * and persist journal + outbox records for replayable progression.
 */
export async function handleDaemonIngress(params: {
  db: DB;
  rawEvent: DaemonEventPayload;
  /** The v2 workflow ID — distinct from rawEvent.loopId (v1 delivery loop ID). */
  workflowId: WorkflowId;
}): Promise<DaemonEventResponse> {
  const signal = normalizeDaemonEvent(params.rawEvent);
  const { workflowId } = params;

  const { appendJournalEventV3, enqueueOutboxRecordV3 } = await import(
    "../../v3/store"
  );

  const now = new Date();
  const canonicalCauseId = buildDaemonCanonicalCauseId(params.rawEvent);
  const v3Source = toV3SignalSource(signal.source);
  const signalPayload = serializeSignalForJournal(signal);

  const writeJournalAndOutbox = async (
    tx: Pick<DB, "insert">,
  ): Promise<void> => {
    const journal = await appendJournalEventV3({
      db: tx,
      workflowId,
      source: v3Source,
      eventType: signal.event.kind,
      idempotencyKey: canonicalCauseId,
      payloadJson: signalPayload,
      occurredAt: now,
    });

    if (!journal.inserted || !journal.id) {
      return;
    }

    await enqueueOutboxRecordV3({
      db: tx,
      outbox: {
        workflowId,
        topic: "signal",
        dedupeKey: `signal:${workflowId}:${v3Source}:${canonicalCauseId}`,
        idempotencyKey: canonicalCauseId,
        availableAt: now,
        maxAttempts: 10,
        payload: {
          kind: "signal",
          journalId: journal.id,
          workflowId,
          eventType: signal.event.kind,
          source: v3Source,
        },
      },
    });
  };

  const transactionalDb = params.db as unknown as {
    transaction?: <T>(fn: (tx: Pick<DB, "insert">) => Promise<T>) => Promise<T>;
  };
  if (typeof transactionalDb.transaction === "function") {
    await transactionalDb.transaction(writeJournalAndOutbox);
  } else {
    await writeJournalAndOutbox(params.db);
  }

  return { selfDispatch: null, workItemsScheduled: 0 };
}
