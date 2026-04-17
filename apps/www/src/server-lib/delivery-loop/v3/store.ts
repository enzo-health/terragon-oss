import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { DB } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import type {
  DeliveryEffectLedgerV3Row,
  DeliveryOutboxV3Row,
  DeliverySignalSourceV3,
  DeliveryWorkflowRow,
  DeliveryWorkflowHeadV3Row,
  DeliveryTimerLedgerV3Row,
} from "@terragon/shared/db/types";
import {
  AWAITING_PR_CREATION_REASON,
  type EffectSpec,
  TERMINAL_WORKFLOW_STATES,
  type WorkflowHead,
} from "./types";
import {
  buildEffectLedgerContract,
  serializeEffectPayload,
  serializeOutboxPayload,
  serializeTimerPayload,
  type OutboxWriteContract,
  type SignalJournalWriteContract,
  type TimerLedgerWriteContract,
} from "./contracts";

const EFFECT_LEASE_TTL_MS = 2 * 60 * 1000;
const TIMER_LEASE_TTL_MS = 2 * 60 * 1000;
const OUTBOX_LEASE_TTL_MS = 2 * 60 * 1000;
function normalizeHeadState(state: string): WorkflowHead["state"] {
  switch (state) {
    case "planning":
      return state;
    case "awaiting_implementation_acceptance":
      return "implementing";
    case "implementing":
    case "gating_review":
    case "gating_ci":
    case "awaiting_pr_creation":
    case "awaiting_pr_lifecycle":
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

function toWorkflowHead(row: DeliveryWorkflowHeadV3Row): WorkflowHead {
  return {
    workflowId: row.workflowId,
    threadId: row.threadId,
    generation: row.generation,
    version: row.version,
    state: normalizeHeadState(row.state),
    activeGate: row.activeGate,
    headSha: row.headSha,
    activeRunId: row.activeRunId,
    activeRunSeq: row.activeRunSeq,
    leaseExpiresAt: row.leaseExpiresAt,
    lastTerminalRunSeq: row.lastTerminalRunSeq,
    fixAttemptCount: row.fixAttemptCount,
    infraRetryCount: row.infraRetryCount,
    maxFixAttempts: row.maxFixAttempts,
    maxInfraRetries: row.maxInfraRetries,
    narrationOnlyRetryCount: row.narrationOnlyRetryCount,
    lastResurrectedAt: row.lastResurrectedAt,
    blockedReason: row.blockedReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
  };
}

export function mapLegacyState(kind: string): WorkflowHead["state"] {
  switch (kind) {
    case "planning":
      return "planning";
    case "implementing":
      return "implementing";
    case "gating":
      return "gating_review";
    case "awaiting_pr":
      return "awaiting_pr_creation";
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

function mapLegacyStateWithPr(params: {
  kind: string;
  prNumber: number | null;
}): WorkflowHead["state"] {
  if (params.kind === "awaiting_pr") {
    return params.prNumber === null
      ? "awaiting_pr_creation"
      : "awaiting_pr_lifecycle";
  }
  return mapLegacyState(params.kind);
}

type LegacyHeadProjection = {
  state: WorkflowHead["state"];
  blockedReason: string | null;
  shouldScheduleEnsurePr: boolean;
};

function projectLegacyToV3Head(params: {
  legacy: {
    kind: string;
    prNumber: number | null;
    blockedReason: string | null;
  };
  currentHeadState?: WorkflowHead["state"];
}): LegacyHeadProjection {
  const staleCiWithoutPr =
    params.currentHeadState === "gating_ci" && params.legacy.prNumber === null;
  const state = staleCiWithoutPr
    ? "awaiting_pr_creation"
    : mapLegacyStateWithPr({
        kind: params.legacy.kind,
        prNumber: params.legacy.prNumber,
      });
  const shouldScheduleEnsurePr =
    state === "awaiting_pr_creation" && params.legacy.prNumber === null;

  return {
    state,
    blockedReason: shouldScheduleEnsurePr
      ? AWAITING_PR_CREATION_REASON
      : (params.legacy.blockedReason ?? null),
    shouldScheduleEnsurePr,
  };
}

function ensurePrReconcileEffects(params: {
  workflowId: string;
  workflowVersion: number;
  now: Date;
}): EffectSpec[] {
  return [
    {
      kind: "ensure_pr",
      effectKey: `${params.workflowId}:${params.workflowVersion}:ensure_pr`,
      dueAt: params.now,
      maxAttempts: 8,
      payload: { kind: "ensure_pr" },
    },
    {
      kind: "publish_status",
      effectKey: `${params.workflowId}:${params.workflowVersion}:publish_status`,
      dueAt: params.now,
      payload: { kind: "publish_status" },
    },
  ];
}

async function reconcileHeadFromProjection(params: {
  db: DB;
  workflowId: string;
  expectedVersion: number;
  headSha: string | null;
  projection: LegacyHeadProjection;
  now: Date;
}): Promise<boolean> {
  const nextVersion = params.expectedVersion + 1;
  const [row] = await params.db
    .update(schema.deliveryWorkflowHeadV3)
    .set({
      version: nextVersion,
      state: params.projection.state,
      activeGate: null,
      headSha: params.headSha,
      activeRunId: null,
      activeRunSeq: null,
      leaseExpiresAt: null,
      lastTerminalRunSeq: null,
      blockedReason: params.projection.blockedReason,
      updatedAt: params.now,
      lastActivityAt: params.now,
    })
    .where(
      and(
        eq(schema.deliveryWorkflowHeadV3.workflowId, params.workflowId),
        eq(schema.deliveryWorkflowHeadV3.version, params.expectedVersion),
      ),
    )
    .returning({ workflowId: schema.deliveryWorkflowHeadV3.workflowId });
  if (!row) {
    return false;
  }
  if (!params.projection.shouldScheduleEnsurePr) {
    return true;
  }
  await insertEffects({
    db: params.db,
    workflowId: params.workflowId,
    workflowVersion: nextVersion,
    effects: ensurePrReconcileEffects({
      workflowId: params.workflowId,
      workflowVersion: nextVersion,
      now: params.now,
    }),
  });
  return true;
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
      headState: headTable.state,
      headSha: headTable.headSha,
      legacyKind: legacyTable.kind,
      legacyPrNumber: legacyTable.prNumber,
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
    const projection = projectLegacyToV3Head({
      legacy: {
        kind: candidate.legacyKind,
        prNumber: candidate.legacyPrNumber,
        blockedReason: candidate.legacyBlockedReason,
      },
      currentHeadState: normalizeHeadState(candidate.headState),
    });
    if (
      projection.state === "gating_review" ||
      projection.state === "gating_ci"
    ) {
      continue;
    }
    const didReconcile = await reconcileHeadFromProjection({
      db: params.db,
      workflowId: candidate.workflowId,
      expectedVersion: candidate.headVersion,
      headSha: candidate.legacyHeadSha ?? candidate.headSha,
      projection,
      now,
    });
    if (didReconcile) {
      reconciled++;
    }
  }
  const noPrCiCandidates = await params.db
    .select({
      workflowId: headTable.workflowId,
      headVersion: headTable.version,
      headSha: headTable.headSha,
      legacyKind: legacyTable.kind,
      legacyPrNumber: legacyTable.prNumber,
      legacyHeadSha: legacyTable.headSha,
      legacyBlockedReason: legacyTable.blockedReason,
    })
    .from(headTable)
    .innerJoin(legacyTable, eq(headTable.workflowId, legacyTable.id))
    .where(
      and(
        eq(headTable.state, "gating_ci"),
        lte(headTable.updatedAt, staleBefore),
        isNull(legacyTable.prNumber),
      ),
    )
    .limit(maxRows);

  for (const candidate of noPrCiCandidates) {
    const projection = projectLegacyToV3Head({
      legacy: {
        kind: candidate.legacyKind,
        prNumber: candidate.legacyPrNumber,
        blockedReason: candidate.legacyBlockedReason,
      },
      currentHeadState: "gating_ci",
    });
    const didReconcile = await reconcileHeadFromProjection({
      db: params.db,
      workflowId: candidate.workflowId,
      expectedVersion: candidate.headVersion,
      headSha: candidate.legacyHeadSha ?? candidate.headSha,
      projection,
      now,
    });
    if (didReconcile) {
      reconciled++;
    }
  }

  return {
    scanned: candidates.length + noPrCiCandidates.length,
    reconciled,
  };
}

export async function getWorkflowHead(params: {
  db: Pick<DB, "query">;
  workflowId: string;
}): Promise<WorkflowHead | null> {
  const row = await params.db.query.deliveryWorkflowHeadV3.findFirst({
    where: eq(schema.deliveryWorkflowHeadV3.workflowId, params.workflowId),
  });
  return row ? toWorkflowHead(row) : null;
}

export async function ensureWorkflowHead(params: {
  db: Pick<DB, "query" | "insert">;
  workflowId: string;
}): Promise<WorkflowHead | null> {
  const existing = await getWorkflowHead({
    db: params.db,
    workflowId: params.workflowId,
  });
  if (existing) return existing;

  const legacy = await params.db.query.deliveryWorkflow.findFirst({
    where: eq(schema.deliveryWorkflow.id, params.workflowId),
  });
  if (!legacy) return null;
  const projection = projectLegacyToV3Head({
    legacy: {
      kind: legacy.kind,
      prNumber: legacy.prNumber,
      blockedReason: legacy.blockedReason ?? null,
    },
  });

  const [inserted] = await params.db
    .insert(schema.deliveryWorkflowHeadV3)
    .values({
      workflowId: legacy.id,
      threadId: legacy.threadId,
      generation: legacy.generation,
      version: legacy.version,
      state: projection.state,
      activeGate: legacy.kind === "gating" ? "review" : null,
      headSha: legacy.headSha ?? null,
      activeRunSeq: null,
      leaseExpiresAt: null,
      lastTerminalRunSeq: null,
      fixAttemptCount: legacy.fixAttemptCount ?? 0,
      infraRetryCount: legacy.infraRetryCount ?? 0,
      maxFixAttempts: legacy.maxFixAttempts ?? 6,
      maxInfraRetries: 10,
      blockedReason: projection.blockedReason,
      lastActivityAt: legacy.lastActivityAt ?? null,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) {
    return toWorkflowHead(inserted);
  }
  return getWorkflowHead({ db: params.db, workflowId: params.workflowId });
}

export type ActiveWorkflowForThread = {
  workflow: DeliveryWorkflowRow;
  head: WorkflowHead;
};

export async function getActiveWorkflowForThread(params: {
  db: Pick<DB, "query" | "select">;
  threadId: string;
}): Promise<ActiveWorkflowForThread | null> {
  const headTable = schema.deliveryWorkflowHeadV3;
  const legacyTable = schema.deliveryWorkflow;

  const row = await params.db
    .select({
      workflow: legacyTable,
      head: headTable,
    })
    .from(headTable)
    .innerJoin(legacyTable, eq(headTable.workflowId, legacyTable.id))
    .where(
      and(
        eq(headTable.threadId, params.threadId),
        notInArray(headTable.state, [...TERMINAL_WORKFLOW_STATES]),
      ),
    )
    .orderBy(desc(headTable.generation), desc(headTable.version))
    .limit(1);

  if (row.length === 0) {
    return null;
  }

  const firstRow = row[0]!;
  return {
    workflow: firstRow.workflow,
    head: toWorkflowHead(firstRow.head),
  };
}

export async function appendJournalEvent(params: {
  db: Pick<DB, "insert">;
  workflowId: string;
  source: DeliverySignalSourceV3;
  eventType: SignalJournalWriteContract["eventType"];
  idempotencyKey: string;
  payloadJson: SignalJournalWriteContract["payload"];
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

export async function updateWorkflowHead(params: {
  db: Pick<DB, "update">;
  head: WorkflowHead;
  expectedVersion: number;
  expectedActiveRunSeq?: number | null;
}): Promise<boolean> {
  const activeRunSeqGuard =
    params.expectedActiveRunSeq === undefined
      ? undefined
      : params.expectedActiveRunSeq === null
        ? isNull(schema.deliveryWorkflowHeadV3.activeRunSeq)
        : eq(
            schema.deliveryWorkflowHeadV3.activeRunSeq,
            params.expectedActiveRunSeq,
          );
  const [row] = await params.db
    .update(schema.deliveryWorkflowHeadV3)
    .set({
      version: params.head.version,
      state: params.head.state,
      activeGate: params.head.activeGate,
      headSha: params.head.headSha,
      activeRunId: params.head.activeRunId,
      activeRunSeq: params.head.activeRunSeq,
      leaseExpiresAt: params.head.leaseExpiresAt,
      lastTerminalRunSeq: params.head.lastTerminalRunSeq,
      fixAttemptCount: params.head.fixAttemptCount,
      infraRetryCount: params.head.infraRetryCount,
      narrationOnlyRetryCount: params.head.narrationOnlyRetryCount,
      lastResurrectedAt: params.head.lastResurrectedAt,
      blockedReason: params.head.blockedReason,
      updatedAt: params.head.updatedAt,
      lastActivityAt: params.head.lastActivityAt,
    })
    .where(
      and(
        eq(schema.deliveryWorkflowHeadV3.workflowId, params.head.workflowId),
        eq(schema.deliveryWorkflowHeadV3.version, params.expectedVersion),
        activeRunSeqGuard,
      ),
    )
    .returning({ workflowId: schema.deliveryWorkflowHeadV3.workflowId });
  return Boolean(row);
}

export async function insertEffects(params: {
  db: Pick<DB, "insert">;
  workflowId: string;
  workflowVersion: number;
  effects: EffectSpec[];
}): Promise<number> {
  if (params.effects.length === 0) return 0;
  const contracts = params.effects.map((effect) =>
    buildEffectLedgerContract({
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
        payloadJson: serializeEffectPayload(effect.payload),
        dueAt: effect.dueAt,
        maxAttempts: effect.maxAttempts,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.deliveryEffectLedgerV3.id });
  return rows.length;
}

export async function claimNextEffect(params: {
  db: DB;
  leaseOwner: string;
  workflowId?: string;
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
  const claimableCondition = params.workflowId
    ? and(eq(t.workflowId, params.workflowId), or(pendingCond, staleCond))
    : or(pendingCond, staleCond);

  const [candidate] = await params.db
    .select({ id: t.id })
    .from(t)
    .where(claimableCondition)
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

export async function markEffectSucceeded(params: {
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

export async function markEffectFailed(params: {
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

export async function cancelEffectByKey(params: {
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

export async function scheduleTimer(params: {
  db: Pick<DB, "insert">;
  timer: TimerLedgerWriteContract;
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
      payloadJson: serializeTimerPayload(params.timer.payload),
      dueAt: params.timer.dueAt,
      maxAttempts: params.timer.maxAttempts,
    })
    .onConflictDoNothing()
    .returning({ id: schema.deliveryTimerLedgerV3.id });
  return { inserted: Boolean(row), id: row?.id ?? null };
}

export async function claimNextTimer(params: {
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

export async function markTimerFired(params: {
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

export async function markTimerFailed(params: {
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

export async function cancelTimerByKey(params: {
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

export async function enqueueOutboxRecord(params: {
  db: Pick<DB, "insert">;
  outbox: OutboxWriteContract;
}): Promise<{ inserted: boolean; id: string | null }> {
  const [row] = await params.db
    .insert(schema.deliveryOutboxV3)
    .values({
      workflowId: params.outbox.workflowId,
      topic: params.outbox.topic,
      dedupeKey: params.outbox.dedupeKey,
      idempotencyKey: params.outbox.idempotencyKey,
      payloadJson: serializeOutboxPayload(params.outbox.payload),
      status: "pending",
      availableAt: params.outbox.availableAt,
      maxAttempts: params.outbox.maxAttempts,
    })
    .onConflictDoNothing()
    .returning({ id: schema.deliveryOutboxV3.id });
  return { inserted: Boolean(row), id: row?.id ?? null };
}

export async function claimNextOutboxRecord(params: {
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

export async function markOutboxPublished(params: {
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

export async function markOutboxFailed(params: {
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
