import type { DB } from "@terragon/shared/db";
import type { DeliverySignalSourceV3 } from "@terragon/shared/db/types";
import * as schema from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { reduce, type InvariantActionV3 } from "./reducer";
import type { LoopEvent } from "./types";
import { buildSignalJournalContract } from "./contracts";
import {
  appendJournalEvent,
  ensureWorkflowHead,
  insertEffects,
  updateWorkflowHead,
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
    await appendJournalEvent({
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

export function normalizeLoopEventForKernel(event: LoopEvent): LoopEvent {
  // No legacy event normalization needed - all events are canonical v3 format
  return event;
}

type KernelAdvanceResult = {
  inserted: boolean;
  transitioned: boolean;
  effectsInserted: number;
  stateBefore: string | null;
  stateAfter: string | null;
};

type KernelAdvanceParams = {
  db: DB;
  workflowId: string;
  source: DeliverySignalSourceV3;
  idempotencyKey: string;
  event: LoopEvent;
  now?: Date;
};

type KernelAdvanceBehavior = {
  applyGateBypass: boolean;
  drainEffects: boolean;
};

export async function appendEventAndAdvanceExplicit(
  params: KernelAdvanceParams & {
    behavior: KernelAdvanceBehavior;
  },
): Promise<KernelAdvanceResult> {
  return appendEventAndAdvanceInternal({
    db: params.db,
    workflowId: params.workflowId,
    source: params.source,
    idempotencyKey: params.idempotencyKey,
    event: params.event,
    now: params.now,
    behavior: params.behavior,
  });
}

async function appendEventAndAdvanceInternal(params: {
  db: DB;
  workflowId: string;
  source: DeliverySignalSourceV3;
  idempotencyKey: string;
  event: LoopEvent;
  now?: Date;
  behavior: KernelAdvanceBehavior;
}): Promise<KernelAdvanceResult> {
  const now = params.now ?? new Date();

  const result = await params.db.transaction(async (tx) => {
    const head = await ensureWorkflowHead({
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

    const eventWithContext = await enrichEventWithWorkflowContext({
      db: tx,
      workflowId: params.workflowId,
      event: params.event,
    });
    const event = normalizeLoopEventForKernel(eventWithContext);

    const signal = buildSignalJournalContract({
      workflowId: params.workflowId,
      source: params.source,
      idempotencyKey: params.idempotencyKey,
      event,
      occurredAt: now,
    });

    const journal = await appendJournalEvent({
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

    const reduced = reduce({
      head,
      event,
      now,
    });

    const updated = await updateWorkflowHead({
      db: tx,
      head: reduced.head,
      expectedVersion: head.version,
      expectedActiveRunSeq: head.activeRunSeq,
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

    const effectsInserted = await insertEffects({
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
  // behavior enables bypassing, immediately inject the corresponding event.
  if (params.behavior.applyGateBypass && result.transitioned) {
    const bypassEvent = gateBypassEvent(result.stateAfter);
    if (bypassEvent) {
      await appendEventAndAdvanceInternal({
        db: params.db,
        workflowId: params.workflowId,
        source: "system",
        idempotencyKey: `${params.idempotencyKey}:gate-bypass:${result.stateAfter}`,
        event: bypassEvent,
        now: params.now,
        behavior: params.behavior,
      });
    }
  }

  // Eagerly drain effects inline instead of waiting for the cron.
  // The cron is a safety net; this awaited drain is the primary path.
  if (result.effectsInserted > 0 && params.behavior.drainEffects) {
    try {
      const { drainDueEffects } = await import("./process-effects");
      await drainDueEffects({
        db: params.db,
        workflowId: params.workflowId,
        maxItems: 5,
        leaseOwnerPrefix: "inline:kernel",
      });
    } catch (err) {
      console.warn(
        "[delivery-loop] inline eager drain failed (cron will recover)",
        {
          workflowId: params.workflowId,
          error: err instanceof Error ? err.message : err,
        },
      );
    }
  }

  return result;
}

async function enrichEventWithWorkflowContext(params: {
  db: Pick<DB, "query">;
  workflowId: string;
  event: LoopEvent;
}): Promise<LoopEvent> {
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

function gateBypassEvent(state: string | null): LoopEvent | null {
  if (state === "gating_review") {
    return { type: "gate_review_passed" };
  }
  if (state === "gating_ci") {
    return { type: "gate_ci_passed" };
  }
  return null;
}
