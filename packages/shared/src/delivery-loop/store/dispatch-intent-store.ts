import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { DB } from "../../db";
import * as schema from "../../db/schema";
import type {
  DispatchIntentDispatchMechanism,
  DispatchIntentExecutionClass,
  DispatchIntentStatus,
} from "../../db/types";
import type {
  DispatchablePhase,
  DispatchIntentStatus as DomainDispatchIntentStatus,
  SelectedAgent,
} from "../domain/dispatch-types";

function assertNever(x: never): never {
  throw new Error("unexpected value: " + x);
}

export type CreateDispatchIntentInput = {
  loopId: string;
  threadId: string;
  threadChatId: string;
  runId: string;
  targetPhase: DispatchablePhase;
  selectedAgent: SelectedAgent;
  executionClass: DispatchIntentExecutionClass;
  dispatchMechanism: DispatchIntentDispatchMechanism;
  retryCount?: number;
};

export function toDispatchIntentStatus(
  status: DomainDispatchIntentStatus,
): DispatchIntentStatus {
  switch (status) {
    case "prepared":
      return "pending";
    case "dispatched":
      return "dispatched";
    case "acknowledged":
      return "acknowledged";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
  }
  return assertNever(status);
}

export function fromDispatchIntentStatus(
  status: DispatchIntentStatus,
): DomainDispatchIntentStatus {
  switch (status) {
    case "pending":
      return "prepared";
    case "dispatched":
      return "dispatched";
    case "acknowledged":
      return "acknowledged";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
  }
  return assertNever(status);
}

/**
 * Persist a new dispatch intent before any dispatch work begins.
 * Returns the generated intent ID.
 */
export async function createDispatchIntent(
  db: DB,
  input: CreateDispatchIntentInput,
): Promise<string> {
  const [row] = await db
    .insert(schema.deliveryLoopDispatchIntent)
    .values({
      loopId: input.loopId,
      threadId: input.threadId,
      threadChatId: input.threadChatId,
      runId: input.runId,
      targetPhase: input.targetPhase,
      selectedAgent: input.selectedAgent,
      executionClass: input.executionClass,
      dispatchMechanism: input.dispatchMechanism,
      status: toDispatchIntentStatus("prepared"),
      retryCount: input.retryCount ?? 0,
    })
    .onConflictDoNothing()
    .returning({ id: schema.deliveryLoopDispatchIntent.id });

  if (row) {
    return row.id;
  }

  const existing = await getDispatchIntentByRunId(db, input.runId);
  if (!existing) {
    throw new Error(
      `Failed to create or locate dispatch intent for runId ${input.runId}`,
    );
  }
  return existing.id;
}

/**
 * Transition a dispatch intent to "dispatched" — daemon message has been sent.
 */
export async function markDispatchIntentDispatched(
  db: DB,
  runId: string,
): Promise<void> {
  await db
    .update(schema.deliveryLoopDispatchIntent)
    .set({
      status: toDispatchIntentStatus("dispatched"),
      dispatchedAt: new Date(),
    })
    .where(eq(schema.deliveryLoopDispatchIntent.runId, runId));
}

/**
 * Transition a dispatch intent to "acknowledged" — first daemon event received.
 *
 * Idempotent: only updates if the current status is "dispatched", so concurrent
 * serverless invocations cannot double-acknowledge. Returns `true` when this
 * call performed the transition (i.e. this is the first event), `false` if the
 * row was already acknowledged or missing.
 */
export async function markDispatchIntentAcknowledged(
  db: DB,
  runId: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.deliveryLoopDispatchIntent)
    .set({
      status: toDispatchIntentStatus("acknowledged"),
      acknowledgedAt: new Date(),
    })
    .where(
      and(
        eq(schema.deliveryLoopDispatchIntent.runId, runId),
        eq(
          schema.deliveryLoopDispatchIntent.status,
          toDispatchIntentStatus("dispatched"),
        ),
      ),
    )
    .returning({ id: schema.deliveryLoopDispatchIntent.id });
  return rows.length > 0;
}

/**
 * Transition a dispatch intent to "completed" — run finished successfully.
 */
export async function markDispatchIntentCompleted(
  db: DB,
  runId: string,
): Promise<void> {
  await db
    .update(schema.deliveryLoopDispatchIntent)
    .set({
      status: toDispatchIntentStatus("completed"),
      completedAt: new Date(),
    })
    .where(eq(schema.deliveryLoopDispatchIntent.runId, runId));
}

/**
 * Transition a dispatch intent to "failed" with failure details.
 */
export async function markDispatchIntentFailed(
  db: DB,
  runId: string,
  failureCategory: string | null,
  failureMessage: string | null,
): Promise<void> {
  await db
    .update(schema.deliveryLoopDispatchIntent)
    .set({
      status: toDispatchIntentStatus("failed"),
      failedAt: new Date(),
      failureCategory,
      failureMessage,
    })
    .where(eq(schema.deliveryLoopDispatchIntent.runId, runId));
}

/**
 * Get the most recent dispatch intent for a loop, optionally filtered by
 * status. Useful for crash recovery — find "dispatched" intents that never
 * got acknowledged.
 */
export async function getLatestDispatchIntentForLoop(
  db: DB,
  loopId: string,
  statusFilter?: DispatchIntentStatus,
) {
  const conditions = [eq(schema.deliveryLoopDispatchIntent.loopId, loopId)];
  if (statusFilter) {
    conditions.push(eq(schema.deliveryLoopDispatchIntent.status, statusFilter));
  }
  const [row] = await db
    .select()
    .from(schema.deliveryLoopDispatchIntent)
    .where(and(...conditions))
    .orderBy(desc(schema.deliveryLoopDispatchIntent.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Get a dispatch intent by its runId.
 */
export async function getDispatchIntentByRunId(db: DB, runId: string) {
  const [row] = await db
    .select()
    .from(schema.deliveryLoopDispatchIntent)
    .where(eq(schema.deliveryLoopDispatchIntent.runId, runId))
    .limit(1);
  return row ?? null;
}

/**
 * Get the latest non-terminal dispatch intent for a thread chat.
 *
 * Useful when Redis real-time intent lookup is unavailable (for example local
 * redis-http transport failures) and we still need a deterministic runId.
 */
export async function getLatestActiveDispatchIntentForThreadChat(
  db: DB,
  input: {
    threadChatId: string;
    loopId?: string;
  },
) {
  const activeStatuses: DispatchIntentStatus[] = [
    "pending",
    "dispatched",
    "acknowledged",
  ];
  const whereClause = input.loopId
    ? and(
        eq(schema.deliveryLoopDispatchIntent.threadChatId, input.threadChatId),
        eq(schema.deliveryLoopDispatchIntent.loopId, input.loopId),
        inArray(schema.deliveryLoopDispatchIntent.status, activeStatuses),
      )
    : and(
        eq(schema.deliveryLoopDispatchIntent.threadChatId, input.threadChatId),
        inArray(schema.deliveryLoopDispatchIntent.status, activeStatuses),
      );
  const [row] = await db
    .select()
    .from(schema.deliveryLoopDispatchIntent)
    .where(whereClause)
    .orderBy(desc(schema.deliveryLoopDispatchIntent.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Find dispatch intents stuck in "dispatched" status for longer than the
 * given timeout. These are dispatches where the daemon never sent its first
 * event back (ack). Used by the ack-timeout cron to detect and fail them.
 *
 * Joins with `thread` to include `userId` so callers can schedule retries
 * without an extra DB lookup.
 */
export async function getStalledDispatchIntents(
  db: DB,
  timeoutMs: number,
  limit = 50,
) {
  const cutoff = new Date(Date.now() - timeoutMs);
  const rows = await db
    .select({
      id: schema.deliveryLoopDispatchIntent.id,
      loopId: schema.deliveryLoopDispatchIntent.loopId,
      threadId: schema.deliveryLoopDispatchIntent.threadId,
      threadChatId: schema.deliveryLoopDispatchIntent.threadChatId,
      runId: schema.deliveryLoopDispatchIntent.runId,
      targetPhase: schema.deliveryLoopDispatchIntent.targetPhase,
      selectedAgent: schema.deliveryLoopDispatchIntent.selectedAgent,
      executionClass: schema.deliveryLoopDispatchIntent.executionClass,
      dispatchMechanism: schema.deliveryLoopDispatchIntent.dispatchMechanism,
      status: schema.deliveryLoopDispatchIntent.status,
      retryCount: schema.deliveryLoopDispatchIntent.retryCount,
      failureCategory: schema.deliveryLoopDispatchIntent.failureCategory,
      failureMessage: schema.deliveryLoopDispatchIntent.failureMessage,
      dispatchedAt: schema.deliveryLoopDispatchIntent.dispatchedAt,
      acknowledgedAt: schema.deliveryLoopDispatchIntent.acknowledgedAt,
      completedAt: schema.deliveryLoopDispatchIntent.completedAt,
      failedAt: schema.deliveryLoopDispatchIntent.failedAt,
      createdAt: schema.deliveryLoopDispatchIntent.createdAt,
      updatedAt: schema.deliveryLoopDispatchIntent.updatedAt,
      userId: schema.thread.userId,
    })
    .from(schema.deliveryLoopDispatchIntent)
    .innerJoin(
      schema.thread,
      eq(schema.deliveryLoopDispatchIntent.threadId, schema.thread.id),
    )
    .where(
      and(
        eq(schema.deliveryLoopDispatchIntent.status, "dispatched"),
        lte(schema.deliveryLoopDispatchIntent.dispatchedAt, cutoff),
      ),
    )
    .orderBy(schema.deliveryLoopDispatchIntent.dispatchedAt)
    .limit(limit);
  return rows;
}
