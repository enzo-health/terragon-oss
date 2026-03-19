import type { DB } from "@terragon/shared/db";
import type { DeliveryEffectLedgerV3Row } from "@terragon/shared/db/types";
import { enqueueWorkItem } from "@terragon/shared/delivery-loop/store/work-queue-store";
import { addMilliseconds } from "date-fns";
import { parseEffectPayloadV3 } from "./contracts";
import { appendEventAndAdvanceV3 } from "./kernel";
import {
  claimNextEffectV3,
  getWorkflowHeadV3,
  markEffectFailedV3,
  markEffectSucceededV3,
} from "./store";

async function processSingleEffect(params: {
  db: DB;
  effect: DeliveryEffectLedgerV3Row;
  leaseOwner: string;
  now: Date;
}) {
  const payload = parseEffectPayloadV3(params.effect.payloadJson);
  if (!payload) {
    await markEffectFailedV3({
      db: params.db,
      effectId: params.effect.id,
      leaseOwner: params.leaseOwner,
      leaseEpoch: params.effect.leaseEpoch,
      errorCode: "invalid_payload",
      errorMessage: "Unsupported effect payload",
      retryAt: addMilliseconds(params.now, 5_000),
    });
    return;
  }

  try {
    if (payload.kind === "dispatch_implementing") {
      await enqueueWorkItem({
        db: params.db,
        workflowId: params.effect.workflowId,
        correlationId: `v3:dispatch:impl:${params.effect.id}`,
        kind: "dispatch",
        payloadJson: {
          executionClass: payload.executionClass,
          workflowId: params.effect.workflowId,
        },
      });
      await markEffectSucceededV3({
        db: params.db,
        effectId: params.effect.id,
        leaseOwner: params.leaseOwner,
        leaseEpoch: params.effect.leaseEpoch,
      });
      return;
    }

    if (payload.kind === "dispatch_gate_review") {
      await enqueueWorkItem({
        db: params.db,
        workflowId: params.effect.workflowId,
        correlationId: `v3:dispatch:review:${params.effect.id}`,
        kind: "dispatch",
        payloadJson: {
          executionClass: "gate_runtime",
          workflowId: params.effect.workflowId,
          gate: payload.gate,
        },
      });
      await markEffectSucceededV3({
        db: params.db,
        effectId: params.effect.id,
        leaseOwner: params.leaseOwner,
        leaseEpoch: params.effect.leaseEpoch,
      });
      return;
    }

    // ack_timeout_check
    const head = await getWorkflowHeadV3({
      db: params.db,
      workflowId: params.effect.workflowId,
    });
    if (!head || head.version !== payload.workflowVersion) {
      await markEffectSucceededV3({
        db: params.db,
        effectId: params.effect.id,
        leaseOwner: params.leaseOwner,
        leaseEpoch: params.effect.leaseEpoch,
      });
      return;
    }

    await appendEventAndAdvanceV3({
      db: params.db,
      workflowId: params.effect.workflowId,
      source: "timer",
      idempotencyKey: `ack-timeout:${payload.runId}:${params.effect.id}`,
      event: {
        type: "dispatch_ack_timeout",
        runId: payload.runId,
      },
    });
    await markEffectSucceededV3({
      db: params.db,
      effectId: params.effect.id,
      leaseOwner: params.leaseOwner,
      leaseEpoch: params.effect.leaseEpoch,
    });
  } catch (error) {
    await markEffectFailedV3({
      db: params.db,
      effectId: params.effect.id,
      leaseOwner: params.leaseOwner,
      leaseEpoch: params.effect.leaseEpoch,
      errorCode: "effect_handler_threw",
      errorMessage: error instanceof Error ? error.message : String(error),
      retryAt: addMilliseconds(params.now, 2_000),
    });
  }
}

export async function drainDueV3Effects(params: {
  db: DB;
  maxItems?: number;
  leaseOwnerPrefix?: string;
  now?: Date;
}): Promise<{ processed: number }> {
  const maxItems = params.maxItems ?? 25;
  const leaseOwnerPrefix = params.leaseOwnerPrefix ?? "cron:v3";
  const now = params.now ?? new Date();

  let processed = 0;
  for (let i = 0; i < maxItems; i++) {
    const leaseOwner = `${leaseOwnerPrefix}:${crypto.randomUUID()}`;
    const effect = await claimNextEffectV3({
      db: params.db,
      leaseOwner,
      now,
    });
    if (!effect) break;
    await processSingleEffect({
      db: params.db,
      effect,
      leaseOwner,
      now,
    });
    processed++;
  }
  return { processed };
}
