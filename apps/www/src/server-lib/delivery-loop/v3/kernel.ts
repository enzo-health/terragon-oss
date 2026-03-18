import type { DB } from "@terragon/shared/db";
import type { DeliverySignalSourceV3 } from "@terragon/shared/db/types";
import { reduceV3 } from "./reducer";
import type { LoopEventV3 } from "./types";
import { buildSignalJournalContractV3 } from "./contracts";
import {
  appendJournalEventV3,
  ensureWorkflowHeadV3,
  insertEffectsV3,
  updateWorkflowHeadV3,
} from "./store";

export async function appendEventAndAdvanceV3(params: {
  db: DB;
  workflowId: string;
  source: DeliverySignalSourceV3;
  idempotencyKey: string;
  event: LoopEventV3;
  now?: Date;
}): Promise<{
  inserted: boolean;
  transitioned: boolean;
  effectsInserted: number;
  stateBefore: string | null;
  stateAfter: string | null;
}> {
  const now = params.now ?? new Date();

  return params.db.transaction(async (tx) => {
    const head = await ensureWorkflowHeadV3({
      db: tx,
      workflowId: params.workflowId,
    });
    if (!head) {
      return {
        inserted: false,
        transitioned: false,
        effectsInserted: 0,
        stateBefore: null,
        stateAfter: null,
      };
    }

    const signal = buildSignalJournalContractV3({
      workflowId: params.workflowId,
      source: params.source,
      idempotencyKey: params.idempotencyKey,
      event: params.event,
      occurredAt: now,
    });

    const journal = await appendJournalEventV3({
      db: tx,
      workflowId: signal.workflowId,
      source: signal.source,
      eventType: signal.eventType,
      idempotencyKey: signal.idempotencyKey,
      payloadJson: signal.payload,
      occurredAt: signal.occurredAt,
    });

    if (!journal.inserted) {
      return {
        inserted: false,
        transitioned: false,
        effectsInserted: 0,
        stateBefore: head.state,
        stateAfter: head.state,
      };
    }

    const reduced = reduceV3({
      head,
      event: params.event,
      now,
    });

    const updated = await updateWorkflowHeadV3({
      db: tx,
      head: reduced.head,
      expectedVersion: head.version,
    });

    if (!updated) {
      return {
        inserted: true,
        transitioned: false,
        effectsInserted: 0,
        stateBefore: head.state,
        stateAfter: head.state,
      };
    }

    const effectsInserted = await insertEffectsV3({
      db: tx,
      workflowId: params.workflowId,
      workflowVersion: reduced.head.version,
      effects: reduced.effects,
    });

    return {
      inserted: true,
      transitioned: reduced.head.state !== head.state,
      effectsInserted,
      stateBefore: head.state,
      stateAfter: reduced.head.state,
    };
  });
}
