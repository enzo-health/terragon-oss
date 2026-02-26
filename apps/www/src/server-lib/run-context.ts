import type { DB } from "@terragon/shared/db";
import { threadRun, threadRunContext } from "@terragon/shared/db/schema";
import type {
  FrozenRunFlagSnapshot,
  ThreadRunStatus,
  ThreadRunTriggerSource,
} from "@terragon/shared/types/preview";
import type { SandboxProvider } from "@terragon/types/sandbox";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

const RUN_CONTEXT_MAX_RETRIES = 5;
const RUN_CONTEXT_BASE_RETRY_DELAY_MS = 25;

const ACTIVE_RUN_STATUSES: readonly ThreadRunStatus[] = [
  "booting",
  "running",
  "validating",
];

type LockedRunContextRow = {
  version: number;
  activeRunId: string;
  activeStatus: ThreadRunStatus;
};

type RunContextSqlExecutor = Pick<DB, "execute">;

class RunContextVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunContextVersionConflictError";
  }
}

function toLockedRunContextRow(row: unknown): LockedRunContextRow {
  if (typeof row !== "object" || row === null) {
    throw new Error("Invalid run context row");
  }
  const record = row as Record<string, unknown>;
  const version = Number(record.version);
  const activeRunId = String(record.active_run_id ?? "");
  const activeStatus = String(record.active_status ?? "") as ThreadRunStatus;

  if (!Number.isFinite(version) || !activeRunId) {
    throw new Error("Invalid locked run context payload");
  }

  return {
    version,
    activeRunId,
    activeStatus,
  };
}

function isConflictError(error: unknown): boolean {
  if (error instanceof RunContextVersionConflictError) {
    return true;
  }

  if (typeof error !== "object" || error === null) {
    return false;
  }

  const code = (error as { code?: string }).code;
  return code === "23505";
}

async function getLockedRunContext({
  db,
  threadId,
  threadChatId,
}: {
  db: RunContextSqlExecutor;
  threadId: string;
  threadChatId: string;
}): Promise<LockedRunContextRow | null> {
  const result = await db.execute(sql`
    SELECT version, active_run_id, active_status
    FROM thread_run_context
    WHERE thread_id = ${threadId}
      AND thread_chat_id = ${threadChatId}
    FOR UPDATE
  `);

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return toLockedRunContextRow(row);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function getRunContextRetryDelayMs(attempt: number): number {
  const clampedAttempt = Math.max(0, attempt);
  const baseDelay = RUN_CONTEXT_BASE_RETRY_DELAY_MS * 2 ** clampedAttempt;
  const jitterRange = Math.max(1, Math.floor(baseDelay * 0.2));
  const jitter =
    Math.floor(Math.random() * (jitterRange * 2 + 1)) - jitterRange;
  return baseDelay + jitter;
}

export function buildFrozenRunFlagSnapshot(
  flags: Record<string, boolean | undefined>,
): FrozenRunFlagSnapshot {
  return {
    sandboxPreview: !!flags.sandboxPreview,
    daemonRunIdStrict: !!flags.daemonRunIdStrict,
    rolloutPhase: null,
  };
}

export async function createRunContext({
  db,
  threadId,
  threadChatId,
  startRequestId,
  triggerSource,
  frozenFlagSnapshot,
}: {
  db: DB;
  threadId: string;
  threadChatId: string;
  startRequestId: string;
  triggerSource: ThreadRunTriggerSource;
  frozenFlagSnapshot: FrozenRunFlagSnapshot;
}): Promise<{ runId: string; frozenFlagSnapshot: FrozenRunFlagSnapshot }> {
  for (let attempt = 0; attempt < RUN_CONTEXT_MAX_RETRIES; attempt += 1) {
    try {
      const result = await db.transaction(async (tx) => {
        const lockedContext = await getLockedRunContext({
          db: tx,
          threadId,
          threadChatId,
        });

        const existingRun = await tx.query.threadRun.findFirst({
          where: and(
            eq(threadRun.threadId, threadId),
            eq(threadRun.threadChatId, threadChatId),
            eq(threadRun.startRequestId, startRequestId),
          ),
          columns: {
            runId: true,
          },
        });

        if (existingRun) {
          return {
            runId: existingRun.runId,
            frozenFlagSnapshot,
          };
        }

        const now = new Date();
        const runId = crypto.randomUUID();

        if (
          lockedContext?.activeRunId &&
          ACTIVE_RUN_STATUSES.includes(lockedContext.activeStatus)
        ) {
          await tx
            .update(threadRun)
            .set({
              status: "finished",
              endedAt: now,
            })
            .where(
              and(
                eq(threadRun.runId, lockedContext.activeRunId),
                isNull(threadRun.endedAt),
              ),
            );
        }

        await tx.insert(threadRun).values({
          runId,
          threadId,
          threadChatId,
          startRequestId,
          triggerSource,
          status: "booting",
          frozenFlagSnapshotJson: frozenFlagSnapshot,
          startedAt: now,
        });

        if (lockedContext) {
          const [updated] = await tx
            .update(threadRunContext)
            .set({
              activeRunId: runId,
              activeCodesandboxId: null,
              activeSandboxProvider: null,
              activeStatus: "booting",
              version: lockedContext.version + 1,
              activeUpdatedAt: now,
            })
            .where(
              and(
                eq(threadRunContext.threadId, threadId),
                eq(threadRunContext.threadChatId, threadChatId),
                eq(threadRunContext.version, lockedContext.version),
              ),
            )
            .returning({
              version: threadRunContext.version,
            });

          if (!updated) {
            throw new RunContextVersionConflictError(
              "Run context version changed during update",
            );
          }
        } else {
          await tx.insert(threadRunContext).values({
            threadId,
            threadChatId,
            activeRunId: runId,
            activeCodesandboxId: null,
            activeSandboxProvider: null,
            activeStatus: "booting",
            version: 0,
            activeUpdatedAt: now,
          });
        }

        return {
          runId,
          frozenFlagSnapshot,
        };
      });

      return result;
    } catch (error) {
      const shouldRetry =
        attempt < RUN_CONTEXT_MAX_RETRIES - 1 && isConflictError(error);
      if (!shouldRetry) {
        throw error;
      }
      await sleep(getRunContextRetryDelayMs(attempt));
    }
  }

  throw new Error("Failed to create run context after retries");
}

export async function bindRunSandbox({
  db,
  threadId,
  threadChatId,
  runId,
  codesandboxId,
  sandboxProvider,
  runStartSha,
}: {
  db: DB;
  threadId: string;
  threadChatId: string;
  runId: string;
  codesandboxId: string;
  sandboxProvider: SandboxProvider;
  runStartSha: string | null;
}): Promise<void> {
  for (let attempt = 0; attempt < RUN_CONTEXT_MAX_RETRIES; attempt += 1) {
    try {
      await db.transaction(async (tx) => {
        const lockedContext = await getLockedRunContext({
          db: tx,
          threadId,
          threadChatId,
        });

        if (!lockedContext) {
          throw new Error(
            `Run context missing for ${threadId}/${threadChatId}`,
          );
        }

        if (lockedContext.activeRunId !== runId) {
          throw new Error(
            `Run mismatch for ${threadId}/${threadChatId}: expected ${lockedContext.activeRunId}, got ${runId}`,
          );
        }

        const now = new Date();

        await tx
          .update(threadRun)
          .set({
            codesandboxId,
            sandboxProvider,
            status: "running",
            runStartSha,
          })
          .where(eq(threadRun.runId, runId));

        const [updated] = await tx
          .update(threadRunContext)
          .set({
            activeRunId: runId,
            activeCodesandboxId: codesandboxId,
            activeSandboxProvider: sandboxProvider,
            activeStatus: "running",
            version: lockedContext.version + 1,
            activeUpdatedAt: now,
          })
          .where(
            and(
              eq(threadRunContext.threadId, threadId),
              eq(threadRunContext.threadChatId, threadChatId),
              eq(threadRunContext.version, lockedContext.version),
            ),
          )
          .returning({
            version: threadRunContext.version,
          });

        if (!updated) {
          throw new RunContextVersionConflictError(
            "Run context version changed during bind",
          );
        }
      });

      return;
    } catch (error) {
      const shouldRetry =
        attempt < RUN_CONTEXT_MAX_RETRIES - 1 && isConflictError(error);
      if (!shouldRetry) {
        throw error;
      }
      await sleep(getRunContextRetryDelayMs(attempt));
    }
  }

  throw new Error("Failed to bind sandbox to run context after retries");
}

export async function updateRunLastAcceptedSeq({
  db,
  runId,
  nextSeq,
}: {
  db: DB;
  runId: string;
  nextSeq: number;
}): Promise<boolean> {
  const [updated] = await db
    .update(threadRun)
    .set({
      lastAcceptedSeq: nextSeq,
    })
    .where(
      and(
        eq(threadRun.runId, runId),
        or(
          isNull(threadRun.lastAcceptedSeq),
          lt(threadRun.lastAcceptedSeq, nextSeq),
        ),
      ),
    )
    .returning({
      runId: threadRun.runId,
    });

  return !!updated;
}
