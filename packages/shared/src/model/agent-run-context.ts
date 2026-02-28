import { and, desc, eq } from "drizzle-orm";
import { DB } from "../db";
import * as schema from "../db/schema";
import {
  AgentRunContext,
  AgentRunContextInsert,
  AgentRunProtocolVersion,
  AgentRunStatus,
  AgentTransportMode,
} from "../db/types";
import { AIAgent } from "@terragon/agent/types";

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
  status: AgentRunStatus;
  tokenNonce: string;
  daemonTokenKeyId?: string | null;
}): Promise<AgentRunContext> {
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
