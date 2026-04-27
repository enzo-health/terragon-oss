import { env } from "@terragon/env/pkg-shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db";
import * as schema from "../db/schema";
import {
  completeAgentRunContextTerminal,
  getAgentRunContextByRunId,
  getLatestAgentRunContextForThreadChat,
  upsertAgentRunContext,
} from "./agent-run-context";
import { createTestThread, createTestUser } from "./test-helpers";

const db = createDb(env.DATABASE_URL!);

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

type RunFixture = {
  userId: string;
  threadId: string;
  threadChatId: string;
  runId: string;
};

async function createRunFixture(): Promise<RunFixture> {
  const { user } = await createTestUser({ db });
  const { threadId, threadChatId } = await createTestThread({
    db,
    userId: user.id,
  });
  return {
    userId: user.id,
    threadId,
    threadChatId,
    runId: newId("run"),
  };
}

async function createRun(
  fixture: RunFixture,
  overrides: Partial<Parameters<typeof upsertAgentRunContext>[0]> = {},
) {
  return upsertAgentRunContext({
    db,
    runId: fixture.runId,
    userId: fixture.userId,
    threadId: fixture.threadId,
    threadChatId: fixture.threadChatId,
    sandboxId: "sandbox-1",
    transportMode: "acp",
    protocolVersion: 2,
    agent: "claudeCode",
    permissionMode: "allowAll",
    requestedSessionId: null,
    resolvedSessionId: null,
    runtimeProvider: "claude-acp",
    status: "processing",
    tokenNonce: "nonce-1",
    daemonTokenKeyId: "api-key-1",
    ...overrides,
  });
}

describe("agent-run-context terminal CAS", () => {
  beforeEach(async () => {
    await db.delete(schema.agentRunContext);
  });

  it("persists runtime session ownership without workflow linkage", async () => {
    const fixture = await createRunFixture();

    const runContext = await createRun(fixture, {
      runtimeProvider: "claude-acp",
      externalSessionId: "session-external-1",
      previousResponseId: "response-prev-1",
      checkpointPointer: "checkpoint://thread/chat/run",
      hibernationValid: true,
      compactionGeneration: 2,
      lastAcceptedSeq: 7,
      terminalEventId: null,
    });

    expect(runContext).toMatchObject({
      runtimeProvider: "claude-acp",
      externalSessionId: "session-external-1",
      previousResponseId: "response-prev-1",
      checkpointPointer: "checkpoint://thread/chat/run",
      hibernationValid: true,
      compactionGeneration: 2,
      lastAcceptedSeq: 7,
      terminalEventId: null,
    });
  });

  it("preserves runtime session fields when a later upsert omits them", async () => {
    const fixture = await createRunFixture();
    await createRun(fixture, {
      runtimeProvider: "claude-acp",
      externalSessionId: "session-external-1",
      previousResponseId: "response-prev-1",
      checkpointPointer: "checkpoint://thread/chat/run",
      hibernationValid: true,
      compactionGeneration: 2,
      lastAcceptedSeq: 7,
    });

    const updated = await createRun(fixture, {
      status: "completed",
      terminalEventId: "event-terminal-1",
    });

    expect(updated).toMatchObject({
      status: "completed",
      runtimeProvider: "claude-acp",
      externalSessionId: "session-external-1",
      previousResponseId: "response-prev-1",
      checkpointPointer: "checkpoint://thread/chat/run",
      hibernationValid: true,
      compactionGeneration: 2,
      lastAcceptedSeq: 7,
      terminalEventId: "event-terminal-1",
    });
  });

  it("commits terminal status when every run-context fence matches", async () => {
    const fixture = await createRunFixture();
    await createRun(fixture, { lastAcceptedSeq: 3 });

    const result = await completeAgentRunContextTerminal({
      db,
      runId: fixture.runId,
      userId: fixture.userId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      transportMode: "acp",
      protocolVersion: 2,
      runtimeProvider: "claude-acp",
      daemonTokenKeyId: "api-key-1",
      terminalStatus: "completed",
      lastAcceptedSeq: 4,
      terminalEventId: "event-terminal-1",
    });

    expect(result.status).toBe("committed");
    expect(result.runContext).toMatchObject({
      status: "completed",
      lastAcceptedSeq: 4,
      terminalEventId: "event-terminal-1",
    });
  });

  it("treats the same winning terminal event as an idempotent duplicate", async () => {
    const fixture = await createRunFixture();
    await createRun(fixture, {
      status: "completed",
      lastAcceptedSeq: 4,
      terminalEventId: "event-terminal-1",
    });

    const result = await completeAgentRunContextTerminal({
      db,
      runId: fixture.runId,
      userId: fixture.userId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      transportMode: "acp",
      protocolVersion: 2,
      runtimeProvider: "claude-acp",
      daemonTokenKeyId: "api-key-1",
      terminalStatus: "completed",
      lastAcceptedSeq: 4,
      terminalEventId: "event-terminal-1",
    });

    expect(result.status).toBe("duplicate");
    if (result.status !== "duplicate") {
      throw new Error("expected duplicate terminal result");
    }
    expect(result.runContext.status).toBe("completed");
  });

  it("rejects a different terminal event after one terminal event already won", async () => {
    const fixture = await createRunFixture();
    await createRun(fixture, {
      status: "completed",
      lastAcceptedSeq: 4,
      terminalEventId: "event-terminal-1",
    });

    const result = await completeAgentRunContextTerminal({
      db,
      runId: fixture.runId,
      userId: fixture.userId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      transportMode: "acp",
      protocolVersion: 2,
      runtimeProvider: "claude-acp",
      daemonTokenKeyId: "api-key-1",
      terminalStatus: "failed",
      lastAcceptedSeq: 5,
      terminalEventId: "event-terminal-2",
    });

    expect(result).toMatchObject({
      status: "rejected",
      reason: "already_terminal_different_event",
    });
  });

  it("rejects a stale terminal for an older run when a newer run is active", async () => {
    const fixture = await createRunFixture();
    await createRun(fixture, { runId: "old-run" });
    await createRun(fixture, { runId: "new-run", status: "processing" });

    const result = await completeAgentRunContextTerminal({
      db,
      runId: "old-run",
      userId: fixture.userId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      transportMode: "acp",
      protocolVersion: 2,
      runtimeProvider: "claude-acp",
      daemonTokenKeyId: "api-key-1",
      terminalStatus: "completed",
      lastAcceptedSeq: 9,
      terminalEventId: "event-terminal-old",
    });

    expect(result).toMatchObject({
      status: "rejected",
      reason: "stale_run",
    });
  });

  it("rejects a stale terminal for an older run when a newer run is completed", async () => {
    const fixture = await createRunFixture();
    await createRun(fixture, { runId: "old-run" });
    await createRun(fixture, {
      runId: "new-run",
      status: "completed",
      lastAcceptedSeq: 12,
      terminalEventId: "event-terminal-new",
    });

    const result = await completeAgentRunContextTerminal({
      db,
      runId: "old-run",
      userId: fixture.userId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      transportMode: "acp",
      protocolVersion: 2,
      runtimeProvider: "claude-acp",
      daemonTokenKeyId: "api-key-1",
      terminalStatus: "completed",
      lastAcceptedSeq: 13,
      terminalEventId: "event-terminal-old-late",
    });
    const oldRun = await getAgentRunContextByRunId({
      db,
      runId: "old-run",
      userId: fixture.userId,
    });

    expect(result).toMatchObject({
      status: "rejected",
      reason: "stale_run",
    });
    expect(oldRun).toMatchObject({
      status: "processing",
      terminalEventId: null,
    });
  });

  it("enforces stale-run fencing atomically in the terminal update predicate", async () => {
    const fixture = await createRunFixture();
    await createRun(fixture, { runId: "old-run" });
    let insertedNewRunBeforeUpdate = false;
    const raceDb = Object.create(db) as typeof db;
    raceDb.update = ((table: Parameters<typeof db.update>[0]) => {
      const updateBuilder = db.update(table);
      return {
        set(values: Parameters<typeof updateBuilder.set>[0]) {
          const setBuilder = updateBuilder.set(values);
          return {
            where(condition: Parameters<typeof setBuilder.where>[0]) {
              const whereBuilder = setBuilder.where(condition);
              return {
                async returning() {
                  if (!insertedNewRunBeforeUpdate) {
                    insertedNewRunBeforeUpdate = true;
                    await createRun(fixture, {
                      runId: "new-run",
                      status: "completed",
                      lastAcceptedSeq: 12,
                      terminalEventId: "event-terminal-raced-new",
                    });
                  }
                  return whereBuilder.returning();
                },
              };
            },
          };
        },
      };
    }) as typeof db.update;

    const result = await completeAgentRunContextTerminal({
      db: raceDb,
      runId: "old-run",
      userId: fixture.userId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      transportMode: "acp",
      protocolVersion: 2,
      runtimeProvider: "claude-acp",
      daemonTokenKeyId: "api-key-1",
      terminalStatus: "completed",
      lastAcceptedSeq: 9,
      terminalEventId: "event-terminal-raced-old",
    });
    const oldRun = await getAgentRunContextByRunId({
      db,
      runId: "old-run",
      userId: fixture.userId,
    });

    expect(insertedNewRunBeforeUpdate).toBe(true);
    expect(result).toMatchObject({
      status: "rejected",
      reason: "stale_run",
    });
    expect(oldRun).toMatchObject({
      status: "processing",
      terminalEventId: null,
    });
  });

  it("fails closed when the token-key fence does not match", async () => {
    const fixture = await createRunFixture();
    await createRun(fixture);

    const result = await completeAgentRunContextTerminal({
      db,
      runId: fixture.runId,
      userId: fixture.userId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      transportMode: "acp",
      protocolVersion: 2,
      runtimeProvider: "claude-acp",
      daemonTokenKeyId: "wrong-key",
      terminalStatus: "completed",
      lastAcceptedSeq: 4,
      terminalEventId: "event-terminal-1",
    });

    expect(result).toMatchObject({
      status: "rejected",
      reason: "token_key_mismatch",
    });
  });

  it("replays latest run/session metadata without runtime session metadata", async () => {
    const fixture = await createRunFixture();
    await createRun(fixture, {
      runId: "older-run",
      runtimeProvider: "claude-acp",
      externalSessionId: "acp-session-old",
      previousResponseId: null,
      lastAcceptedSeq: 2,
      status: "completed",
    });
    const latest = await createRun(fixture, {
      runId: "latest-run",
      transportMode: "codex-app-server",
      protocolVersion: 1,
      agent: "codex",
      runtimeProvider: "codex-app-server",
      externalSessionId: "codex-thread-1",
      previousResponseId: "resp-latest",
      lastAcceptedSeq: 9,
      terminalEventId: "event-terminal-latest",
      status: "completed",
    });

    const result = await getLatestAgentRunContextForThreadChat({
      db,
      userId: fixture.userId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
    });

    expect(result).toMatchObject({
      runId: latest.runId,
      transportMode: "codex-app-server",
      protocolVersion: 1,
      runtimeProvider: "codex-app-server",
      externalSessionId: "codex-thread-1",
      previousResponseId: "resp-latest",
      lastAcceptedSeq: 9,
      terminalEventId: "event-terminal-latest",
      status: "completed",
    });
  });
});
