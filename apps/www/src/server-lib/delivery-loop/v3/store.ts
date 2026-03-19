import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { DB } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import type {
  DeliveryEffectLedgerV3Row,
  DeliveryOutboxV3Row,
  DeliverySignalSourceV3,
  DeliveryWorkflowHeadV3Row,
  DeliveryTimerLedgerV3Row,
} from "@terragon/shared/db/types";
import type { EffectSpecV3, WorkflowHeadV3 } from "./types";
import {
  buildEffectLedgerContractV3,
  serializeEffectPayloadV3,
  serializeOutboxPayloadV3,
  serializeTimerPayloadV3,
  type OutboxWriteContractV3,
  type SignalJournalWriteContractV3,
  type TimerLedgerWriteContractV3,
} from "./contracts";

const EFFECT_LEASE_TTL_MS = 2 * 60 * 1000;
const TIMER_LEASE_TTL_MS = 2 * 60 * 1000;
const OUTBOX_LEASE_TTL_MS = 2 * 60 * 1000;

function normalizeHeadState(state: string): WorkflowHeadV3["state"] {
  switch (state) {
    case "planning":
    case "implementing":
    case "gating_review":
    case "gating_ci":
    case "awaiting_pr":
    case "awaiting_manual_fix":
    case "awaiting_operator_action":
    case "done":
    case "stopped":
    case "terminated":
      return state;
    default:
      return "implementing";
  }
}

function toWorkflowHeadV3(row: DeliveryWorkflowHeadV3Row): WorkflowHeadV3 {
  return {
    workflowId: row.workflowId,
    threadId: row.threadId,
    generation: row.generation,
    version: row.version,
    state: normalizeHeadState(row.state),
    activeGate: row.activeGate,
    headSha: row.headSha,
    activeRunId: row.activeRunId,
    fixAttemptCount: row.fixAttemptCount,
    infraRetryCount: row.infraRetryCount,
    maxFixAttempts: row.maxFixAttempts,
    maxInfraRetries: row.maxInfraRetries,
    blockedReason: row.blockedReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
  };
}

export function mapLegacyStateToV3(kind: string): WorkflowHeadV3["state"] {
  switch (kind) {
    case "planning":
      return "planning";
    case "implementing":
      return "implementing";
    case "gating":
      return "gating_review";
    case "awaiting_pr":
      return "awaiting_pr";
    case "awaiting_manual_fix":
      return "awaiting_manual_fix";
    case "awaiting_operator_action":
      return "awaiting_operator_action";
    case "done":
      return "done";
    case "stopped":
      return "stopped";
    case "terminated":
      return "terminated";
    default:
      return "implementing";
  }
}

const ZOMBIE_GATE_STATES = ["gating_review", "gating_ci"] as const;
const LEGACY_RECONCILABLE_KINDS = [
  "awaiting_pr",
  "awaiting_manual_fix",
  "awaiting_operator_action",
  "done",
  "stopped",
  "terminated",
] as const;

export async function reconcileZombieGateHeadsFromLegacy(params: {
  db: DB;
  now?: Date;
  staleMs?: number;
  maxRows?: number;
}): Promise<{ scanned: number; reconciled: number }> {
  const now = params.now ?? new Date();
  const staleMs = params.staleMs ?? 90_000;
  const maxRows = params.maxRows ?? 20;
  const staleBefore = new Date(now.getTime() - staleMs);

  const headTable = schema.deliveryWorkflowHeadV3;
  const legacyTable = schema.deliveryWorkflow;

  const candidates = await params.db
    .select({
      workflowId: headTable.workflowId,
      headVersion: headTable.version,
      headSha: headTable.headSha,
      legacyKind: legacyTable.kind,
      legacyHeadSha: legacyTable.headSha,
      legacyBlockedReason: legacyTable.blockedReason,
    })
    .from(headTable)
    .innerJoin(legacyTable, eq(headTable.workflowId, legacyTable.id))
    .where(
      and(
        inArray(headTable.state, [...ZOMBIE_GATE_STATES]),
        lte(headTable.updatedAt, staleBefore),
        inArray(legacyTable.kind, [...LEGACY_RECONCILABLE_KINDS]),
      ),
    )
    .limit(maxRows);

  let reconciled = 0;
  for (const candidate of candidates) {
    const targetState = mapLegacyStateToV3(candidate.legacyKind);
    if (targetState === "gating_review" || targetState === "gating_ci") {
      continue;
    }
    const [row] = await params.db
      .update(headTable)
      .set({
        version: candidate.headVersion + 1,
        state: targetState,
        activeGate: null,
        headSha: candidate.legacyHeadSha ?? candidate.headSha,
        activeRunId: null,
        blockedReason: candidate.legacyBlockedReason ?? null,
        updatedAt: now,
        lastActivityAt: now,
      })
      .where(
        and(
          eq(headTable.workflowId, candidate.workflowId),
          eq(headTable.version, candidate.headVersion),
        ),
      )
      .returning({ workflowId: headTable.workflowId });
    if (row) {
      reconciled++;
    }
  }

  return { scanned: candidates.length, reconciled };
}

export async function getWorkflowHeadV3(params: {
  db: Pick<DB, "query">;
  workflowId: string;
}): Promise<WorkflowHeadV3 | null> {
  const row = await params.db.query.deliveryWorkflowHeadV3.findFirst({
    where: eq(schema.deliveryWorkflowHeadV3.workflowId, params.workflowId),
  });
  return row ? toWorkflowHeadV3(row) : null;
}

export async function ensureWorkflowHeadV3(params: {
  db: Pick<DB, "query" | "insert">;
  workflowId: string;
}): Promise<WorkflowHeadV3 | null> {
  const existing = await getWorkflowHeadV3({
    db: params.db,
    workflowId: params.workflowId,
  });
  if (existing) return existing;

  const legacy = await params.db.query.deliveryWorkflow.findFirst({
    where: eq(schema.deliveryWorkflow.id, params.workflowId),
  });
  if (!legacy) return null;

  const [inserted] = await params.db
    .insert(schema.deliveryWorkflowHeadV3)
    .values({
      workflowId: legacy.id,
      threadId: legacy.threadId,
      generation: legacy.generation,
      version: legacy.version,
      state: mapLegacyStateToV3(legacy.kind),
      activeGate: legacy.kind === "gating" ? "review" : null,
      headSha: legacy.headSha ?? null,
      fixAttemptCount: legacy.fixAttemptCount ?? 0,
      infraRetryCount: legacy.infraRetryCount ?? 0,
      maxFixAttempts: legacy.maxFixAttempts ?? 6,
      maxInfraRetries: 10,
      blockedReason: legacy.blockedReason ?? null,
      lastActivityAt: legacy.lastActivityAt ?? null,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) {
    return toWorkflowHeadV3(inserted);
  }
  return getWorkflowHeadV3({ db: params.db, workflowId: params.workflowId });
}

export async function appendJournalEventV3(params: {
  db: Pick<DB, "insert">;
  workflowId: string;
  source: DeliverySignalSourceV3;
  eventType: SignalJournalWriteContractV3["eventType"];
  idempotencyKey: string;
  payloadJson: SignalJournalWriteContractV3["payload"];
  occurredAt?: Date;
}): Promise<{ inserted: boolean; id: string | null }> {
  const [row] = await params.db
    .insert(schema.deliveryLoopJournalV3)
    .values({
      workflowId: params.workflowId,
      source: params.source,
      eventType: params.eventType,
      idempotencyKey: params.idempotencyKey,
      payloadJson: params.payloadJson,
      occurredAt: params.occurredAt ?? new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: schema.deliveryLoopJournalV3.id });
  return { inserted: Boolean(row), id: row?.id ?? null };
}

export async function updateWorkflowHeadV3(params: {
  db: Pick<DB, "update">;
  head: WorkflowHeadV3;
  expectedVersion: number;
}): Promise<boolean> {
  const [row] = await params.db
    .update(schema.deliveryWorkflowHeadV3)
    .set({
      version: params.head.version,
      state: params.head.state,
      activeGate: params.head.activeGate,
      headSha: params.head.headSha,
      activeRunId: params.head.activeRunId,
      fixAttemptCount: params.head.fixAttemptCount,
      infraRetryCount: params.head.infraRetryCount,
      blockedReason: params.head.blockedReason,
      updatedAt: params.head.updatedAt,
      lastActivityAt: params.head.lastActivityAt,
    })
    .where(
      and(
        eq(schema.deliveryWorkflowHeadV3.workflowId, params.head.workflowId),
        eq(schema.deliveryWorkflowHeadV3.version, params.expectedVersion),
      ),
    )
    .returning({ workflowId: schema.deliveryWorkflowHeadV3.workflowId });
  return Boolean(row);
}

export async function insertEffectsV3(params: {
  db: Pick<DB, "insert">;
  workflowId: string;
  workflowVersion: number;
  effects: EffectSpecV3[];
}): Promise<number> {
  if (params.effects.length === 0) return 0;
  const contracts = params.effects.map((effect) =>
    buildEffectLedgerContractV3({
      workflowId: params.workflowId,
      workflowVersion: params.workflowVersion,
      effect,
    }),
  );

  const rows = await params.db
    .insert(schema.deliveryEffectLedgerV3)
    .values(
      contracts.map((effect) => ({
        workflowId: effect.workflowId,
        workflowVersion: effect.workflowVersion,
        effectKind: effect.effectKind,
        effectKey: effect.effectKey,
        idempotencyKey: effect.idempotencyKey,
        payloadJson: serializeEffectPayloadV3(effect.payload),
        dueAt: effect.dueAt,
        maxAttempts: effect.maxAttempts,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.deliveryEffectLedgerV3.id });
  return rows.length;
}

export async function claimNextEffectV3(params: {
  db: DB;
  leaseOwner: string;
  now?: Date;
}): Promise<DeliveryEffectLedgerV3Row | null> {
  const now = params.now ?? new Date();
  const staleThreshold = new Date(now.getTime() - EFFECT_LEASE_TTL_MS);
  const leaseExpiresAt = new Date(now.getTime() + EFFECT_LEASE_TTL_MS);
  const t = schema.deliveryEffectLedgerV3;

  const pendingCond = and(eq(t.status, "planned"), lte(t.dueAt, now));
  const staleCond = and(
    eq(t.status, "running"),
    lte(t.leaseExpiresAt, staleThreshold),
  );

  const [candidate] = await params.db
    .select({ id: t.id })
    .from(t)
    .where(or(pendingCond, staleCond))
    .orderBy(t.dueAt, t.createdAt)
    .limit(1)
    .for("update", { skipLocked: true });

  if (!candidate) return null;

  const [claimed] = await params.db
    .update(t)
    .set({
      status: "running",
      leaseOwner: params.leaseOwner,
      claimedAt: now,
      leaseExpiresAt,
      leaseEpoch: sql`${t.leaseEpoch} + 1`,
      attemptCount: sql`${t.attemptCount} + 1`,
    })
    .where(
      and(
        eq(t.id, candidate.id),
        or(
          and(eq(t.status, "planned"), lte(t.dueAt, now)),
          and(eq(t.status, "running"), lte(t.leaseExpiresAt, staleThreshold)),
        ),
      ),
    )
    .returning();

  return claimed ?? null;
}

export async function markEffectSucceededV3(params: {
  db: Pick<DB, "update">;
  effectId: string;
  leaseOwner: string;
  leaseEpoch: number;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const [row] = await params.db
    .update(schema.deliveryEffectLedgerV3)
    .set({
      status: "succeeded",
      completedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(schema.deliveryEffectLedgerV3.id, params.effectId),
        eq(schema.deliveryEffectLedgerV3.leaseOwner, params.leaseOwner),
        eq(schema.deliveryEffectLedgerV3.leaseEpoch, params.leaseEpoch),
        eq(schema.deliveryEffectLedgerV3.status, "running"),
      ),
    )
    .returning({ id: schema.deliveryEffectLedgerV3.id });
  return Boolean(row);
}

export async function markEffectFailedV3(params: {
  db: Pick<DB, "update">;
  effectId: string;
  leaseOwner: string;
  leaseEpoch: number;
  errorCode: string;
  errorMessage: string;
  retryAt: Date;
}): Promise<void> {
  await params.db
    .update(schema.deliveryEffectLedgerV3)
    .set({
      status: sql`CASE WHEN ${schema.deliveryEffectLedgerV3.attemptCount} >= ${schema.deliveryEffectLedgerV3.maxAttempts} THEN 'dead_letter' ELSE 'planned' END`,
      dueAt: params.retryAt,
      lastErrorCode: params.errorCode,
      lastErrorMessage: params.errorMessage,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(schema.deliveryEffectLedgerV3.id, params.effectId),
        eq(schema.deliveryEffectLedgerV3.leaseOwner, params.leaseOwner),
        eq(schema.deliveryEffectLedgerV3.leaseEpoch, params.leaseEpoch),
        eq(schema.deliveryEffectLedgerV3.status, "running"),
      ),
    );
}

export async function cancelEffectByKeyV3(params: {
  db: Pick<DB, "update">;
  effectKey: string;
}): Promise<void> {
  await params.db
    .update(schema.deliveryEffectLedgerV3)
    .set({
      status: "cancelled",
      completedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(schema.deliveryEffectLedgerV3.effectKey, params.effectKey),
        or(
          eq(schema.deliveryEffectLedgerV3.status, "planned"),
          eq(schema.deliveryEffectLedgerV3.status, "running"),
        ),
      ),
    );
}

export async function scheduleTimerV3(params: {
  db: Pick<DB, "insert">;
  timer: TimerLedgerWriteContractV3;
}): Promise<{ inserted: boolean; id: string | null }> {
  const [row] = await params.db
    .insert(schema.deliveryTimerLedgerV3)
    .values({
      workflowId: params.timer.workflowId,
      timerKind: params.timer.timerKind,
      timerKey: params.timer.timerKey,
      idempotencyKey: params.timer.idempotencyKey,
      sourceSignalId: params.timer.sourceSignalId,
      status: "planned",
      payloadJson: serializeTimerPayloadV3(params.timer.payload),
      dueAt: params.timer.dueAt,
      maxAttempts: params.timer.maxAttempts,
    })
    .onConflictDoNothing()
    .returning({ id: schema.deliveryTimerLedgerV3.id });
  return { inserted: Boolean(row), id: row?.id ?? null };
}

export async function claimNextTimerV3(params: {
  db: DB;
  leaseOwner: string;
  now?: Date;
}): Promise<DeliveryTimerLedgerV3Row | null> {
  const now = params.now ?? new Date();
  const staleThreshold = new Date(now.getTime() - TIMER_LEASE_TTL_MS);
  const leaseExpiresAt = new Date(now.getTime() + TIMER_LEASE_TTL_MS);
  const t = schema.deliveryTimerLedgerV3;

  const pendingCond = and(eq(t.status, "planned"), lte(t.dueAt, now));
  const staleCond = and(
    eq(t.status, "running"),
    lte(t.leaseExpiresAt, staleThreshold),
  );

  const [candidate] = await params.db
    .select({ id: t.id })
    .from(t)
    .where(or(pendingCond, staleCond))
    .orderBy(t.dueAt, t.createdAt)
    .limit(1)
    .for("update", { skipLocked: true });

  if (!candidate) return null;

  const [claimed] = await params.db
    .update(t)
    .set({
      status: "running",
      leaseOwner: params.leaseOwner,
      claimedAt: now,
      leaseExpiresAt,
      leaseEpoch: sql`${t.leaseEpoch} + 1`,
      attemptCount: sql`${t.attemptCount} + 1`,
    })
    .where(
      and(
        eq(t.id, candidate.id),
        or(
          and(eq(t.status, "planned"), lte(t.dueAt, now)),
          and(eq(t.status, "running"), lte(t.leaseExpiresAt, staleThreshold)),
        ),
      ),
    )
    .returning();

  return claimed ?? null;
}

export async function markTimerFiredV3(params: {
  db: Pick<DB, "update">;
  timerId: string;
  leaseOwner: string;
  leaseEpoch: number;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const [row] = await params.db
    .update(schema.deliveryTimerLedgerV3)
    .set({
      status: "fired",
      firedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(schema.deliveryTimerLedgerV3.id, params.timerId),
        eq(schema.deliveryTimerLedgerV3.leaseOwner, params.leaseOwner),
        eq(schema.deliveryTimerLedgerV3.leaseEpoch, params.leaseEpoch),
        eq(schema.deliveryTimerLedgerV3.status, "running"),
      ),
    )
    .returning({ id: schema.deliveryTimerLedgerV3.id });
  return Boolean(row);
}

export async function markTimerFailedV3(params: {
  db: Pick<DB, "update">;
  timerId: string;
  leaseOwner: string;
  leaseEpoch: number;
  errorCode: string;
  errorMessage: string;
  retryAt: Date;
}): Promise<void> {
  await params.db
    .update(schema.deliveryTimerLedgerV3)
    .set({
      status: sql`CASE WHEN ${schema.deliveryTimerLedgerV3.attemptCount} >= ${schema.deliveryTimerLedgerV3.maxAttempts} THEN 'dead_letter' ELSE 'planned' END`,
      dueAt: params.retryAt,
      lastErrorCode: params.errorCode,
      lastErrorMessage: params.errorMessage,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(schema.deliveryTimerLedgerV3.id, params.timerId),
        eq(schema.deliveryTimerLedgerV3.leaseOwner, params.leaseOwner),
        eq(schema.deliveryTimerLedgerV3.leaseEpoch, params.leaseEpoch),
        eq(schema.deliveryTimerLedgerV3.status, "running"),
      ),
    );
}

export async function cancelTimerByKeyV3(params: {
  db: Pick<DB, "update">;
  workflowId: string;
  timerKey: string;
}): Promise<void> {
  await params.db
    .update(schema.deliveryTimerLedgerV3)
    .set({
      status: "cancelled",
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(schema.deliveryTimerLedgerV3.workflowId, params.workflowId),
        eq(schema.deliveryTimerLedgerV3.timerKey, params.timerKey),
        or(
          eq(schema.deliveryTimerLedgerV3.status, "planned"),
          eq(schema.deliveryTimerLedgerV3.status, "running"),
        ),
      ),
    );
}

export async function enqueueOutboxRecordV3(params: {
  db: Pick<DB, "insert">;
  outbox: OutboxWriteContractV3;
}): Promise<{ inserted: boolean; id: string | null }> {
  const [row] = await params.db
    .insert(schema.deliveryOutboxV3)
    .values({
      workflowId: params.outbox.workflowId,
      topic: params.outbox.topic,
      dedupeKey: params.outbox.dedupeKey,
      idempotencyKey: params.outbox.idempotencyKey,
      payloadJson: serializeOutboxPayloadV3(params.outbox.payload),
      status: "pending",
      availableAt: params.outbox.availableAt,
      maxAttempts: params.outbox.maxAttempts,
    })
    .onConflictDoNothing()
    .returning({ id: schema.deliveryOutboxV3.id });
  return { inserted: Boolean(row), id: row?.id ?? null };
}

export async function claimNextOutboxRecordV3(params: {
  db: DB;
  leaseOwner: string;
  workflowId?: string;
  now?: Date;
}): Promise<DeliveryOutboxV3Row | null> {
  const now = params.now ?? new Date();
  const staleThreshold = new Date(now.getTime() - OUTBOX_LEASE_TTL_MS);
  const leaseExpiresAt = new Date(now.getTime() + OUTBOX_LEASE_TTL_MS);
  const t = schema.deliveryOutboxV3;

  const pendingCond = and(eq(t.status, "pending"), lte(t.availableAt, now));
  const staleCond = and(
    eq(t.status, "publishing"),
    lte(t.leaseExpiresAt, staleThreshold),
  );
  const claimableCondition = params.workflowId
    ? and(eq(t.workflowId, params.workflowId), or(pendingCond, staleCond))
    : or(pendingCond, staleCond);

  const [candidate] = await params.db
    .select({ id: t.id })
    .from(t)
    .where(claimableCondition)
    .orderBy(t.availableAt, t.createdAt)
    .limit(1)
    .for("update", { skipLocked: true });

  if (!candidate) return null;

  const [claimed] = await params.db
    .update(t)
    .set({
      status: "publishing",
      leaseOwner: params.leaseOwner,
      claimedAt: now,
      leaseExpiresAt,
      leaseEpoch: sql`${t.leaseEpoch} + 1`,
      attemptCount: sql`${t.attemptCount} + 1`,
    })
    .where(
      and(
        eq(t.id, candidate.id),
        ...(params.workflowId ? [eq(t.workflowId, params.workflowId)] : []),
        or(
          and(eq(t.status, "pending"), lte(t.availableAt, now)),
          and(
            eq(t.status, "publishing"),
            lte(t.leaseExpiresAt, staleThreshold),
          ),
        ),
      ),
    )
    .returning();

  return claimed ?? null;
}

export async function markOutboxPublishedV3(params: {
  db: Pick<DB, "update">;
  outboxId: string;
  leaseOwner: string;
  leaseEpoch: number;
  relayMessageId: string | null;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const [row] = await params.db
    .update(schema.deliveryOutboxV3)
    .set({
      status: "published",
      publishedAt: now,
      relayMessageId: params.relayMessageId,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(schema.deliveryOutboxV3.id, params.outboxId),
        eq(schema.deliveryOutboxV3.leaseOwner, params.leaseOwner),
        eq(schema.deliveryOutboxV3.leaseEpoch, params.leaseEpoch),
        eq(schema.deliveryOutboxV3.status, "publishing"),
      ),
    )
    .returning({ id: schema.deliveryOutboxV3.id });
  return Boolean(row);
}

export async function markOutboxFailedV3(params: {
  db: Pick<DB, "update">;
  outboxId: string;
  leaseOwner: string;
  leaseEpoch: number;
  errorCode: string;
  errorMessage: string;
  retryAt: Date;
}): Promise<void> {
  await params.db
    .update(schema.deliveryOutboxV3)
    .set({
      status: sql`CASE WHEN ${schema.deliveryOutboxV3.attemptCount} >= ${schema.deliveryOutboxV3.maxAttempts} THEN 'dead_letter' ELSE 'pending' END`,
      availableAt: params.retryAt,
      lastErrorCode: params.errorCode,
      lastErrorMessage: params.errorMessage,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(schema.deliveryOutboxV3.id, params.outboxId),
        eq(schema.deliveryOutboxV3.leaseOwner, params.leaseOwner),
        eq(schema.deliveryOutboxV3.leaseEpoch, params.leaseEpoch),
        eq(schema.deliveryOutboxV3.status, "publishing"),
      ),
    );
}
