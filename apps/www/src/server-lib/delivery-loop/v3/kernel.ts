import type { DB } from "@terragon/shared/db";
import type { DeliverySignalSourceV3 } from "@terragon/shared/db/types";
import * as schema from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { reduceV3, type InvariantActionV3 } from "./reducer";
import type { LoopEventV3 } from "./types";
import { buildSignalJournalContractV3 } from "./contracts";
import {
  appendJournalEventV3,
  ensureWorkflowHeadV3,
  insertEffectsV3,
  updateWorkflowHeadV3,
} from "./store";

function serializeInvariantAction(params: {
  action: InvariantActionV3;
  headBefore: string;
  headAfter: string;
  workflowVersion: number;
}) {
  return {
    kind: "invariant_action",
    actionKind: params.action.kind,
    headBefore: params.headBefore,
    headAfter: params.headAfter,
    workflowVersion: params.workflowVersion,
    details: params.action,
  };
}

async function appendInvariantJournalActions(params: {
  db: Pick<DB, "insert">;
  workflowId: string;
  baseIdempotencyKey: string;
  headBefore: string;
  headAfter: string;
  workflowVersion: number;
  actions: InvariantActionV3[];
  now: Date;
}): Promise<void> {
  if (params.actions.length === 0) return;

  for (const action of params.actions) {
    await appendJournalEventV3({
      db: params.db,
      workflowId: params.workflowId,
      source: "system",
      eventType: "invariant_action",
      idempotencyKey: `${params.baseIdempotencyKey}:invariant:${params.workflowVersion}:${action.kind}`,
      payloadJson: {
        ...serializeInvariantAction({
          action,
          headBefore: params.headBefore,
          headAfter: params.headAfter,
          workflowVersion: params.workflowVersion,
        }),
      },
      occurredAt: params.now,
    });
  }
}

export async function appendEventAndAdvanceV3(params: {
  db: DB;
  workflowId: string;
  source: DeliverySignalSourceV3;
  idempotencyKey: string;
  event: LoopEventV3;
  now?: Date;
  /** When true, auto-injects bypass events for gating states (edge-triggered). */
  skipGates?: boolean;
}): Promise<{
  inserted: boolean;
  transitioned: boolean;
  effectsInserted: number;
  stateBefore: string | null;
  stateAfter: string | null;
}> {
  const now = params.now ?? new Date();

  const result = await params.db.transaction(async (tx) => {
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

    const event = await enrichEventWithWorkflowContext({
      db: tx,
      workflowId: params.workflowId,
      event: params.event,
    });

    const signal = buildSignalJournalContractV3({
      workflowId: params.workflowId,
      source: params.source,
      idempotencyKey: params.idempotencyKey,
      event,
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
      event,
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

    await appendInvariantJournalActions({
      db: tx,
      workflowId: params.workflowId,
      baseIdempotencyKey: `${params.workflowId}:${params.idempotencyKey}`,
      headBefore: head.state,
      headAfter: reduced.head.state,
      workflowVersion: reduced.head.version,
      actions: reduced.invariantActions,
      now,
    });

    return {
      inserted: true,
      transitioned: reduced.head.state !== head.state,
      effectsInserted,
      stateBefore: head.state,
      stateAfter: reduced.head.state,
    };
  });

  // Edge-triggered gate bypass: if we just entered a gating state and
  // skipGates is on, immediately inject the corresponding bypass event.
  if (params.skipGates && result.transitioned) {
    const bypassEvent = gateBypassEvent(result.stateAfter);
    if (bypassEvent) {
      await appendEventAndAdvanceV3({
        db: params.db,
        workflowId: params.workflowId,
        source: "system",
        idempotencyKey: `${params.idempotencyKey}:gate-bypass:${result.stateAfter}`,
        event: bypassEvent,
        now: params.now,
        skipGates: true,
      });
    }
  }

  return result;
}

async function enrichEventWithWorkflowContext(params: {
  db: Pick<DB, "query">;
  workflowId: string;
  event: LoopEventV3;
}): Promise<LoopEventV3> {
  if (
    params.event.type !== "gate_review_passed" &&
    params.event.type !== "pr_linked"
  ) {
    return params.event;
  }

  if (params.event.prNumber !== undefined) {
    return params.event;
  }

  const workflow = await params.db.query.deliveryWorkflow.findFirst({
    columns: { prNumber: true },
    where: eq(schema.deliveryWorkflow.id, params.workflowId),
  });

  return {
    ...params.event,
    prNumber: workflow?.prNumber ?? null,
  };
}

function gateBypassEvent(state: string | null): LoopEventV3 | null {
  if (state === "gating_review") {
    return { type: "gate_review_passed" };
  }
  if (state === "gating_ci") {
    return { type: "gate_ci_passed" };
  }
  return null;
}
