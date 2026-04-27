import type { AIAgent } from "@terragon/agent/types";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { DB } from "../db";
import * as schema from "../db/schema";
import type {
  AgentRunContext,
  AgentRunContextInsert,
  AgentRunProtocolVersion,
  AgentRunStatus,
  AgentRuntimeProvider,
  AgentTransportMode,
} from "../db/types";

const TERMINAL_RUN_STATUSES = ["completed", "failed", "stopped"] as const;
const NON_TERMINAL_RUN_STATUSES = [
  "pending",
  "dispatched",
  "processing",
] as const;

type RuntimeSessionInsertValues = Pick<
  AgentRunContextInsert,
  | "runtimeProvider"
  | "externalSessionId"
  | "previousResponseId"
  | "checkpointPointer"
  | "hibernationValid"
  | "compactionGeneration"
  | "lastAcceptedSeq"
  | "terminalEventId"
>;

export async function upsertAgentRunContext({
  db,
  runId,
  userId,
  threadId,
  threadChatId,
  sandboxId,
  transportMode,
  protocolVersion,
  agent,
  permissionMode,
  requestedSessionId,
  resolvedSessionId,
  runtimeProvider,
  externalSessionId,
  previousResponseId,
  checkpointPointer,
  hibernationValid,
  compactionGeneration,
  lastAcceptedSeq,
  terminalEventId,
  status,
  tokenNonce,
  daemonTokenKeyId,
}: {
  db: DB;
  runId: string;
  userId: string;
  threadId: string;
  threadChatId: string;
  sandboxId: string;
  transportMode: AgentTransportMode;
  protocolVersion: AgentRunProtocolVersion;
  agent: AIAgent;
  permissionMode: "allowAll" | "plan";
  requestedSessionId: string | null;
  resolvedSessionId: string | null;
  runtimeProvider?: AgentRuntimeProvider | null;
  externalSessionId?: string | null;
  previousResponseId?: string | null;
  checkpointPointer?: string | null;
  hibernationValid?: boolean | null;
  compactionGeneration?: number | null;
  lastAcceptedSeq?: number | null;
  terminalEventId?: string | null;
  status: AgentRunStatus;
  tokenNonce: string;
  daemonTokenKeyId?: string | null;
}): Promise<AgentRunContext> {
  const runtimeSessionValues: RuntimeSessionInsertValues = {
    runtimeProvider: runtimeProvider ?? null,
    externalSessionId: externalSessionId ?? null,
    previousResponseId: previousResponseId ?? null,
    checkpointPointer: checkpointPointer ?? null,
    hibernationValid: hibernationValid ?? null,
    compactionGeneration: compactionGeneration ?? null,
    lastAcceptedSeq: lastAcceptedSeq ?? null,
    terminalEventId: terminalEventId ?? null,
  };
  const runtimeSessionUpdateValues: Partial<RuntimeSessionInsertValues> = {};
  if (runtimeProvider !== undefined) {
    runtimeSessionUpdateValues.runtimeProvider = runtimeProvider;
  }
  if (externalSessionId !== undefined) {
    runtimeSessionUpdateValues.externalSessionId = externalSessionId;
  }
  if (previousResponseId !== undefined) {
    runtimeSessionUpdateValues.previousResponseId = previousResponseId;
  }
  if (checkpointPointer !== undefined) {
    runtimeSessionUpdateValues.checkpointPointer = checkpointPointer;
  }
  if (hibernationValid !== undefined) {
    runtimeSessionUpdateValues.hibernationValid = hibernationValid;
  }
  if (compactionGeneration !== undefined) {
    runtimeSessionUpdateValues.compactionGeneration = compactionGeneration;
  }
  if (lastAcceptedSeq !== undefined) {
    runtimeSessionUpdateValues.lastAcceptedSeq = lastAcceptedSeq;
  }
  if (terminalEventId !== undefined) {
    runtimeSessionUpdateValues.terminalEventId = terminalEventId;
  }

  const values: AgentRunContextInsert = {
    runId,
    userId,
    threadId,
    threadChatId,
    sandboxId,
    transportMode,
    protocolVersion,
    agent,
    permissionMode,
    requestedSessionId,
    resolvedSessionId,
    ...runtimeSessionValues,
    status,
    tokenNonce,
    daemonTokenKeyId: daemonTokenKeyId ?? null,
  };

  const [record] = await db
    .insert(schema.agentRunContext)
    .values(values)
    .onConflictDoUpdate({
      target: schema.agentRunContext.runId,
      set: {
        userId,
        threadId,
        threadChatId,
        sandboxId,
        transportMode,
        protocolVersion,
        agent,
        permissionMode,
        requestedSessionId,
        resolvedSessionId,
        ...runtimeSessionUpdateValues,
        status,
        tokenNonce,
        daemonTokenKeyId: daemonTokenKeyId ?? null,
      },
    })
    .returning();

  if (!record) {
    throw new Error(`failed to upsert agent run context for run ${runId}`);
  }
  return record;
}

export async function getAgentRunContextByRunId({
  db,
  runId,
  userId,
}: {
  db: DB;
  runId: string;
  userId: string;
}): Promise<AgentRunContext | null> {
  const result = await db.query.agentRunContext.findFirst({
    where: and(
      eq(schema.agentRunContext.runId, runId),
      eq(schema.agentRunContext.userId, userId),
    ),
  });
  return result ?? null;
}

export async function updateAgentRunContext({
  db,
  runId,
  userId,
  updates,
}: {
  db: DB;
  runId: string;
  userId: string;
  updates: Partial<
    Pick<
      AgentRunContextInsert,
      | "requestedSessionId"
      | "resolvedSessionId"
      | "status"
      | "daemonTokenKeyId"
      | "sandboxId"
      | "transportMode"
      | "protocolVersion"
      | "permissionMode"
      | "agent"
      | "runtimeProvider"
      | "externalSessionId"
      | "previousResponseId"
      | "checkpointPointer"
      | "hibernationValid"
      | "compactionGeneration"
      | "lastAcceptedSeq"
      | "terminalEventId"
    >
  >;
}): Promise<AgentRunContext | null> {
  const [updated] = await db
    .update(schema.agentRunContext)
    .set(updates)
    .where(
      and(
        eq(schema.agentRunContext.runId, runId),
        eq(schema.agentRunContext.userId, userId),
      ),
    )
    .returning();
  return updated ?? null;
}

type TerminalRunContextUpdate = Pick<
  AgentRunContextInsert,
  | "status"
  | "lastAcceptedSeq"
  | "terminalEventId"
  | "failureCategory"
  | "failureSource"
  | "failureRetryable"
  | "failureSignatureHash"
  | "failureTerminalReason"
>;

export type CompleteAgentRunContextTerminalResult =
  | {
      status: "committed";
      runContext: AgentRunContext;
    }
  | {
      status: "duplicate";
      runContext: AgentRunContext;
    }
  | {
      status: "rejected";
      reason:
        | "run_context_not_found"
        | "context_mismatch"
        | "token_key_mismatch"
        | "runtime_provider_mismatch"
        | "stale_sequence"
        | "stale_run"
        | "already_terminal_different_event";
      runContext: AgentRunContext | null;
    };

function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly AgentRunStatus[]).includes(status);
}

function terminalEventAlreadyWon(
  runContext: AgentRunContext,
  terminalEventId: string,
): boolean {
  return (
    isTerminalRunStatus(runContext.status) &&
    runContext.terminalEventId === terminalEventId
  );
}

function contextMatchesTerminalFence(params: {
  runContext: AgentRunContext;
  threadId: string;
  threadChatId: string;
  transportMode: AgentTransportMode;
  protocolVersion: AgentRunProtocolVersion;
}): boolean {
  return (
    params.runContext.threadId === params.threadId &&
    params.runContext.threadChatId === params.threadChatId &&
    params.runContext.transportMode === params.transportMode &&
    params.runContext.protocolVersion === params.protocolVersion
  );
}

async function getNewestRunContextForThreadChat({
  db,
  userId,
  threadId,
  threadChatId,
}: {
  db: DB;
  userId: string;
  threadId: string;
  threadChatId: string;
}): Promise<AgentRunContext | null> {
  const result = await db.query.agentRunContext.findFirst({
    where: and(
      eq(schema.agentRunContext.userId, userId),
      eq(schema.agentRunContext.threadId, threadId),
      eq(schema.agentRunContext.threadChatId, threadChatId),
    ),
    orderBy: [
      desc(schema.agentRunContext.createdAt),
      desc(schema.agentRunContext.updatedAt),
    ],
  });
  return result ?? null;
}

export async function completeAgentRunContextTerminal({
  db,
  runId,
  userId,
  threadId,
  threadChatId,
  transportMode,
  protocolVersion,
  runtimeProvider,
  daemonTokenKeyId,
  terminalStatus,
  lastAcceptedSeq,
  terminalEventId,
  failureUpdates,
}: {
  db: DB;
  runId: string;
  userId: string;
  threadId: string;
  threadChatId: string;
  transportMode: AgentTransportMode;
  protocolVersion: AgentRunProtocolVersion;
  runtimeProvider?: AgentRuntimeProvider | null;
  daemonTokenKeyId?: string | null;
  terminalStatus: Extract<AgentRunStatus, "completed" | "failed" | "stopped">;
  lastAcceptedSeq: number;
  terminalEventId: string;
  failureUpdates?: Partial<
    Pick<
      AgentRunContextInsert,
      | "failureCategory"
      | "failureSource"
      | "failureRetryable"
      | "failureSignatureHash"
      | "failureTerminalReason"
    >
  >;
}): Promise<CompleteAgentRunContextTerminalResult> {
  const runContext = await getAgentRunContextByRunId({ db, runId, userId });
  if (!runContext) {
    return {
      status: "rejected",
      reason: "run_context_not_found",
      runContext: null,
    };
  }

  if (terminalEventAlreadyWon(runContext, terminalEventId)) {
    return { status: "duplicate", runContext };
  }

  if (isTerminalRunStatus(runContext.status)) {
    return {
      status: "rejected",
      reason: "already_terminal_different_event",
      runContext,
    };
  }

  if (
    !contextMatchesTerminalFence({
      runContext,
      threadId,
      threadChatId,
      transportMode,
      protocolVersion,
    })
  ) {
    return {
      status: "rejected",
      reason: "context_mismatch",
      runContext,
    };
  }

  if (
    daemonTokenKeyId !== undefined &&
    runContext.daemonTokenKeyId !== daemonTokenKeyId
  ) {
    return {
      status: "rejected",
      reason: "token_key_mismatch",
      runContext,
    };
  }

  if (
    runtimeProvider !== undefined &&
    runContext.runtimeProvider !== runtimeProvider
  ) {
    return {
      status: "rejected",
      reason: "runtime_provider_mismatch",
      runContext,
    };
  }

  const newestRun = await getNewestRunContextForThreadChat({
    db,
    userId,
    threadId,
    threadChatId,
  });
  if (newestRun && newestRun.runId !== runId) {
    return {
      status: "rejected",
      reason: "stale_run",
      runContext,
    };
  }

  if (
    runContext.lastAcceptedSeq !== null &&
    runContext.lastAcceptedSeq >= lastAcceptedSeq
  ) {
    return {
      status: "rejected",
      reason: "stale_sequence",
      runContext,
    };
  }

  const updates: TerminalRunContextUpdate = {
    status: terminalStatus,
    lastAcceptedSeq,
    terminalEventId,
    failureCategory: failureUpdates?.failureCategory ?? null,
    failureSource: failureUpdates?.failureSource ?? null,
    failureRetryable: failureUpdates?.failureRetryable ?? null,
    failureSignatureHash: failureUpdates?.failureSignatureHash ?? null,
    failureTerminalReason: failureUpdates?.failureTerminalReason ?? null,
  };

  const predicates = [
    eq(schema.agentRunContext.runId, runId),
    eq(schema.agentRunContext.userId, userId),
    eq(schema.agentRunContext.threadId, threadId),
    eq(schema.agentRunContext.threadChatId, threadChatId),
    eq(schema.agentRunContext.transportMode, transportMode),
    eq(schema.agentRunContext.protocolVersion, protocolVersion),
    inArray(schema.agentRunContext.status, NON_TERMINAL_RUN_STATUSES),
    or(
      isNull(schema.agentRunContext.lastAcceptedSeq),
      lt(schema.agentRunContext.lastAcceptedSeq, lastAcceptedSeq),
    ),
    sql`not exists (
      select 1
      from agent_run_context newer_agent_run_context
      where newer_agent_run_context.user_id = ${userId}
        and newer_agent_run_context.thread_id = ${threadId}
        and newer_agent_run_context.thread_chat_id = ${threadChatId}
        and newer_agent_run_context.run_id <> ${runId}
        and (
          newer_agent_run_context.created_at > ${schema.agentRunContext.createdAt}
          or (
            newer_agent_run_context.created_at = ${schema.agentRunContext.createdAt}
            and newer_agent_run_context.updated_at > ${schema.agentRunContext.updatedAt}
          )
        )
    )`,
  ];
  if (daemonTokenKeyId !== undefined) {
    predicates.push(
      daemonTokenKeyId === null
        ? isNull(schema.agentRunContext.daemonTokenKeyId)
        : eq(schema.agentRunContext.daemonTokenKeyId, daemonTokenKeyId),
    );
  }
  if (runtimeProvider !== undefined) {
    predicates.push(
      runtimeProvider === null
        ? isNull(schema.agentRunContext.runtimeProvider)
        : eq(schema.agentRunContext.runtimeProvider, runtimeProvider),
    );
  }

  const [updated] = await db
    .update(schema.agentRunContext)
    .set(updates)
    .where(and(...predicates))
    .returning();

  if (updated) {
    return { status: "committed", runContext: updated };
  }

  const latest = await getAgentRunContextByRunId({ db, runId, userId });
  if (latest && terminalEventAlreadyWon(latest, terminalEventId)) {
    return { status: "duplicate", runContext: latest };
  }
  const latestNewestRun = await getNewestRunContextForThreadChat({
    db,
    userId,
    threadId,
    threadChatId,
  });
  if (latestNewestRun && latestNewestRun.runId !== runId) {
    return {
      status: "rejected",
      reason: "stale_run",
      runContext: latest,
    };
  }
  return {
    status: "rejected",
    reason:
      latest?.lastAcceptedSeq != null ? "stale_sequence" : "context_mismatch",
    runContext: latest,
  };
}

export async function getLatestAgentRunContextForThreadChat({
  db,
  userId,
  threadId,
  threadChatId,
}: {
  db: DB;
  userId: string;
  threadId: string;
  threadChatId: string;
}): Promise<AgentRunContext | null> {
  const result = await db.query.agentRunContext.findFirst({
    where: and(
      eq(schema.agentRunContext.userId, userId),
      eq(schema.agentRunContext.threadId, threadId),
      eq(schema.agentRunContext.threadChatId, threadChatId),
    ),
    orderBy: [desc(schema.agentRunContext.updatedAt)],
  });
  return result ?? null;
}
