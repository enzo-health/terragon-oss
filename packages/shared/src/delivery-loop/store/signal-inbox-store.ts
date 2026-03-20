/**
 * Signal inbox store — thin re-exports from signal-inbox-core.ts
 * adapted for the new delivery-loop v2 store naming convention.
 */
export {
  claimNextUnprocessedSignal,
  refreshSignalClaim,
  releaseSignalClaim,
  completeSignalClaim,
  deferSignalProcessing,
  deadLetterSignal,
  shouldDeadLetterSignal,
} from "../../model/signal-inbox-core";

import { randomUUID } from "node:crypto";
import * as schema from "../../db/schema";
import type { DB } from "../../db";
import type { DeliveryLoopCauseType } from "../../db/types";

/**
 * Append a new signal to the inbox for a given workflow/loop.
 * This is the v2 entry point used by ingress adapters.
 */
export async function appendSignalToInbox(params: {
  db: Pick<DB, "insert">;
  loopId: string;
  causeType: DeliveryLoopCauseType;
  payload: Record<string, unknown>;
  canonicalCauseId?: string;
  signalHeadShaOrNull?: string | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const [row] = await params.db
    .insert(schema.deliverySignalInbox)
    .values({
      loopId: params.loopId,
      causeType: params.causeType,
      canonicalCauseId: params.canonicalCauseId ?? randomUUID(),
      signalHeadShaOrNull: params.signalHeadShaOrNull ?? null,
      payload: params.payload,
      receivedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.deliverySignalInbox.id });
  return row ?? null;
}
