import type { BaseEvent } from "@ag-ui/core";
import type { DaemonEventAPIBody } from "@terragon/daemon/shared";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDeltaRunEndRows } from "@/server-lib/ag-ui-publisher";
import { isTerminalRunEventType } from "@/server-lib/ag-ui/ag-ui-replay-planner";
import {
  foldRows,
  type ProtocolRow,
  validateBatch,
  createRunProtocolState,
} from "@/server-lib/ag-ui/run-protocol-validator";
import { loadRecording } from "./replayer";
import { replay } from "./replayer";

const dbMocks = vi.hoisted(() => {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const insertReturning = vi.fn().mockResolvedValue([{ id: "sig-1" }]);
  const insertOnConflictDoNothing = vi.fn(() => ({
    returning: insertReturning,
  }));
  const insertValues = vi.fn((_values: unknown) => ({
    onConflictDoNothing: insertOnConflictDoNothing,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const deleteReturning = vi.fn().mockResolvedValue([{ id: "sig-1" }]);
  const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
  const deleteFrom = vi.fn(() => ({ where: deleteWhere }));
  const updateReturning = vi.fn().mockResolvedValue([{ id: "sig-1" }]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const transaction = vi.fn(async (cb: (tx: unknown) => unknown) =>
    cb({ execute, select, insert, delete: deleteFrom, update }),
  );
  return {
    execute,
    insertValues,
    transaction,
    db: { execute, transaction, select, delete: deleteFrom, update, insert },
  };
});

vi.mock("@/lib/auth-server", () => ({
  getDaemonTokenAuthContextOrNull: vi.fn().mockResolvedValue(null),
  userOnlyAction: vi.fn((fn: unknown) => fn),
}));

vi.mock("@/server-lib/handle-daemon-event", () => ({
  handleDaemonEvent: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/db", () => ({ db: dbMocks.db }));

vi.mock("@/server-lib/process-follow-up-queue", () => ({
  maybeProcessFollowUpQueue: vi.fn().mockResolvedValue({
    processed: false,
    dispatchLaunched: false,
    reason: "no_queued_messages",
  }),
}));

vi.mock("@/server-lib/follow-up", () => ({
  queueFollowUpInternal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server-lib/daemon-event-db-preflight", () => ({
  getDaemonEventDbPreflight: vi.fn().mockResolvedValue({
    agentEventLogReady: true,
    agentRunContextFailureColumnsReady: true,
    missing: [],
  }),
}));

const runContextMocks = vi.hoisted(() => {
  const contexts = new Map<string, Record<string, unknown>>();
  return { contexts };
});

vi.mock("@terragon/shared/model/agent-run-context", () => ({
  completeAgentRunContextTerminal: vi
    .fn()
    .mockImplementation(async (params) => ({
      status: "committed",
      runContext: {
        runId: params.runId,
        userId: params.userId,
        threadId: params.threadId,
        threadChatId: params.threadChatId,
        status: params.terminalStatus,
      },
    })),
  getAgentRunContextByRunId: vi
    .fn()
    .mockImplementation(async ({ runId }: { runId: string }) => {
      return runContextMocks.contexts.get(runId) ?? null;
    }),
  updateAgentRunContext: vi.fn().mockResolvedValue(null),
}));

vi.mock("@terragon/shared/model/threads", () => ({
  getThreadChat: vi.fn().mockResolvedValue(null),
  getThreadMinimal: vi.fn().mockResolvedValue(null),
  updateThreadChat: vi.fn().mockResolvedValue(null),
  updateThreadChatTerminalMetadataIfTerminal: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/agent/update-status", () => ({
  updateThreadChatWithTransition: vi.fn().mockResolvedValue({
    updatedStatus: null,
    didUpdateStatus: false,
  }),
}));

vi.mock("@terragon/shared/broadcast-server", () => ({
  publishBroadcastUserMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/redis", () => {
  const pipeline = () => ({
    xadd: vi.fn(),
    expire: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    srem: vi.fn(),
    scard: vi.fn(),
    exec: vi.fn().mockResolvedValue([]),
  });
  return {
    redis: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      smembers: vi.fn().mockResolvedValue([]),
      xadd: vi.fn().mockResolvedValue("1-0"),
      expire: vi.fn().mockResolvedValue(1),
      xrevrange: vi.fn().mockResolvedValue({}),
      pipeline: vi.fn(pipeline),
    },
    isLocalRedisHttpMode: vi.fn().mockReturnValue(false),
    isRedisTransportParseError: vi.fn().mockReturnValue(false),
  };
});

const RECORDINGS = [
  "acp-standard-turn.jsonl",
  "acp-streaming-turn.jsonl",
  "claude-code-standard-turn.jsonl",
  "codex-collab-agent-turn.jsonl",
] as const;

function recordingPath(name: string): string {
  return path.resolve(import.meta.dirname, "recordings", name);
}

function contextFromBody(body: DaemonEventAPIBody): Record<string, unknown> {
  return {
    runId: body.runId,
    userId: "test-user-replay",
    threadId: body.threadId,
    threadChatId: body.threadChatId,
    sandboxId: `sandbox-${body.runId}`,
    transportMode: body.transportMode ?? "acp",
    protocolVersion: body.protocolVersion ?? 2,
    agent: "claudeCode",
    permissionMode: "allowAll",
    requestedSessionId: null,
    resolvedSessionId: null,
    status: "dispatched",
    tokenNonce: `nonce-${body.runId}`,
    daemonTokenKeyId: `key-${body.runId}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

type CapturedRow = { runId: string; event: BaseEvent; eventId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function captureAgUiRows(): CapturedRow[] {
  const rows: CapturedRow[] = [];
  for (const [value] of dbMocks.insertValues.mock.calls) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (
        isRecord(candidate) &&
        typeof candidate.eventId === "string" &&
        typeof candidate.eventType === "string" &&
        typeof candidate.runId === "string" &&
        isRecord(candidate.payloadJson)
      ) {
        rows.push({
          runId: candidate.runId,
          eventId: candidate.eventId,
          event: candidate.payloadJson as unknown as BaseEvent,
        });
      }
    }
  }
  return rows;
}

function groupByRun(rows: CapturedRow[]): Map<string, ProtocolRow[]> {
  const byRun = new Map<string, ProtocolRow[]>();
  for (const row of rows) {
    const existing = byRun.get(row.runId) ?? [];
    existing.push({ event: row.event, eventId: row.eventId });
    byRun.set(row.runId, existing);
  }
  return byRun;
}

function reconstructPersistedRows(
  runId: string,
  rows: ProtocolRow[],
): ProtocolRow[] {
  const terminalIndex = rows.findIndex((row) =>
    isTerminalRunEventType(row.event.type),
  );
  if (terminalIndex < 0) {
    return rows;
  }
  const preTerminalState = foldRows(runId, rows.slice(0, terminalIndex));
  const openMessages = [
    ...[...preTerminalState.openTextMessageIds].map((messageId) => ({
      messageId,
      kind: "text" as const,
    })),
    ...[...preTerminalState.openReasoningMessageIds].map((messageId) => ({
      messageId,
      kind: "thinking" as const,
    })),
  ];
  if (openMessages.length === 0) {
    return rows;
  }
  const endRows: ProtocolRow[] = buildDeltaRunEndRows({
    runId,
    openMessages,
  }).map((row) => ({ event: row.event, eventId: row.eventId }));
  return [
    ...rows.slice(0, terminalIndex),
    ...endRows,
    ...rows.slice(terminalIndex),
  ];
}

describe("write-time protocol validity — harness gate", () => {
  const coveredEventTypes = new Set<string>();

  beforeEach(() => {
    vi.clearAllMocks();
    runContextMocks.contexts.clear();
  });

  it.each(RECORDINGS)(
    "%s persists AG-UI rows that pass the write-time protocol validator",
    async (recordingName) => {
      const file = recordingPath(recordingName);
      const events = loadRecording(file);
      expect(events.length).toBeGreaterThan(0);

      for (const event of events) {
        const body = event.body as DaemonEventAPIBody;
        if (body.runId) {
          runContextMocks.contexts.set(body.runId, contextFromBody(body));
        }
      }

      await replay(events, { mode: "fast-forward" });

      const byRun = groupByRun(captureAgUiRows());

      for (const [runId, rows] of byRun) {
        for (const row of rows) {
          coveredEventTypes.add(String(row.event.type));
        }

        const raw = validateBatch(createRunProtocolState(runId), rows);
        const structural = raw.violations.filter(
          (violation) => violation.kind !== "missing_end_at_terminal",
        );
        expect(
          structural,
          `structural violations for ${recordingName} run ${runId}`,
        ).toEqual([]);

        const reconstructed = reconstructPersistedRows(runId, rows);
        const validated = validateBatch(
          createRunProtocolState(runId),
          reconstructed,
        );
        expect(
          validated.violations,
          `violations for ${recordingName} run ${runId}`,
        ).toEqual([]);
      }
    },
  );

  it("exercised the run + text lifecycle (guards against a persistence regression that would make the gate vacuous)", () => {
    expect([...coveredEventTypes].sort()).toEqual(
      expect.arrayContaining([
        "RUN_STARTED",
        "RUN_FINISHED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
      ]),
    );
  });
});
