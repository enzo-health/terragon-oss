import type { DB } from "@terragon/shared/db";
import type { DeliverySignalSourceV3 } from "@terragon/shared/db/types";
import type {
  WorkflowId,
  GateKind,
} from "@terragon/shared/delivery-loop/domain/workflow";
import type { DeliverySignal } from "@terragon/shared/delivery-loop/domain/signals";

export type HumanAction = "resume" | "bypass" | "stop" | "mark_done";

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

/**
 * Normalize a human action to a typed DeliverySignal.
 */
export function normalizeHumanAction(params: {
  action: HumanAction;
  actorUserId: string;
  gate?: GateKind;
}): DeliverySignal {
  switch (params.action) {
    case "resume":
      return {
        source: "human",
        event: {
          kind: "resume_requested",
          actorUserId: params.actorUserId,
        },
      };
    case "bypass":
      return {
        source: "human",
        event: {
          kind: "bypass_requested",
          actorUserId: params.actorUserId,
          target: params.gate ?? "ci",
        },
      };
    case "stop":
      return {
        source: "human",
        event: {
          kind: "stop_requested",
          actorUserId: params.actorUserId,
        },
      };
    case "mark_done":
      return {
        source: "human",
        event: {
          kind: "mark_done_requested",
          actorUserId: params.actorUserId,
        },
      };
  }
}

/**
 * Handle a human action: normalize to a typed signal
 * and persist journal + outbox records.
 */
export async function handleHumanAction(params: {
  db: DB;
  action: HumanAction;
  actorUserId: string;
  workflowId: WorkflowId;
  /** V1 delivery loop ID used as inbox partition key. Must match the key cron uses to drain. */
  inboxPartitionKey: string;
  gate?: GateKind;
  /** Optional request-scoped idempotency key. When provided, duplicate calls with the same key are deduplicated. Falls back to a random UUID. */
  idempotencyKey?: string;
}): Promise<void> {
  const signal = normalizeHumanAction({
    action: params.action,
    actorUserId: params.actorUserId,
    gate: params.gate,
  });

  const { appendJournalEventV3, enqueueOutboxRecordV3 } = await import(
    "../../v3/store"
  );

  const now = new Date();
  const canonicalCauseId = `human:${params.workflowId}:${params.action}:${params.idempotencyKey ?? crypto.randomUUID()}`;
  const v3Source = toV3SignalSource(signal.source);
  const signalPayload = serializeSignalForJournal(signal);

  const writeJournalAndOutbox = async (
    tx: Pick<DB, "insert">,
  ): Promise<void> => {
    const journal = await appendJournalEventV3({
      db: tx,
      workflowId: params.workflowId,
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
        workflowId: params.workflowId,
        topic: "signal",
        dedupeKey: `signal:${params.workflowId}:${v3Source}:${canonicalCauseId}`,
        idempotencyKey: canonicalCauseId,
        availableAt: now,
        maxAttempts: 10,
        payload: {
          kind: "signal",
          journalId: journal.id,
          workflowId: params.workflowId,
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
}
