import type { BaseEvent } from "@ag-ui/core";
import type {
  ClaudeMessage,
  DaemonEventAPIBody,
} from "@terragon/daemon/shared";
import { buildCanonicalEventsForBatch } from "@terragon/daemon/daemon-canonical-events";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRecording, replay } from "./replayer";
import type { RecordedDaemonEvent } from "./types";

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

type InjectedCanonical = {
  events: RecordedDaemonEvent[];
  providerRichEventIds: Set<string>;
  envelopeEventIds: Set<string>;
};

function withInjectedCanonicalEvents(
  events: RecordedDaemonEvent[],
): InjectedCanonical {
  const providerRichEventIds = new Set<string>();
  const envelopeEventIds = new Set<string>();
  let nextCanonicalSeq = 0;
  let runStartedEmitted = false;
  let terminalEmitted = false;

  const injected = events.map((event) => {
    const body = event.body;
    if (typeof body.eventId === "string") {
      envelopeEventIds.add(body.eventId);
    }
    const messages = (body.messages ?? []) as ClaudeMessage[];
    const result = buildCanonicalEventsForBatch({
      runId: body.runId as string,
      agent: "claudeCode",
      model: null,
      transportMode: "acp",
      protocolVersion: 2,
      nextCanonicalSeq,
      canonicalRunStartedEmitted: runStartedEmitted,
      canonicalTerminalEmitted: terminalEmitted,
      streamedAssistantText: false,
      threadId: body.threadId as string,
      threadChatId: body.threadChatId as string,
      timezone: "UTC",
      messages,
    });
    nextCanonicalSeq = result.nextCanonicalSeqAfterBatch;
    runStartedEmitted = result.canonicalRunStartedEmittedAfterBatch;
    terminalEmitted = result.canonicalTerminalEmittedAfterBatch;
    for (const canonicalEvent of result.canonicalEvents) {
      if (canonicalEvent.type === "provider-rich-part") {
        providerRichEventIds.add(canonicalEvent.eventId);
      }
    }
    return {
      ...event,
      body: {
        ...body,
        canonicalEvents: result.canonicalEvents,
      },
    };
  });

  return { events: injected, providerRichEventIds, envelopeEventIds };
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

describe("dual-source rich rows — messages[] + canonicalEvents coexistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runContextMocks.contexts.clear();
  });

  it("persists rich rows from the provider-rich-part carrier, never the messages[] fallback", async () => {
    const recorded = loadRecording(recordingPath("acp-standard-turn.jsonl"));
    const { events, providerRichEventIds, envelopeEventIds } =
      withInjectedCanonicalEvents(recorded);

    expect(providerRichEventIds.size).toBeGreaterThan(0);

    const firstBody = events[0]!.body;
    runContextMocks.contexts.set(
      firstBody.runId as string,
      contextFromBody(firstBody),
    );

    const results = await replay(events, { mode: "fast-forward" });
    for (const result of results) {
      expect(result.status).toBeLessThan(400);
    }

    const rows = captureAgUiRows();
    const richPrefixes = [...providerRichEventIds].map((id) => `msg:${id}:`);
    const envelopePrefixes = [...envelopeEventIds].map((id) => `msg:${id}:`);

    const customRows = rows.filter((row) => row.event.type === "CUSTOM");
    const toolStartRows = rows.filter(
      (row) => row.event.type === "TOOL_CALL_START",
    );
    expect(customRows.length).toBeGreaterThan(0);
    expect(toolStartRows.length).toBeGreaterThan(0);

    const richRows = [...customRows, ...toolStartRows];
    for (const row of richRows) {
      expect(
        richPrefixes.some((prefix) => row.eventId.startsWith(prefix)),
      ).toBe(true);
      expect(
        envelopePrefixes.some((prefix) => row.eventId.startsWith(prefix)),
      ).toBe(false);
    }

    const eventIds = rows.map((row) => row.eventId);
    expect(new Set(eventIds).size).toBe(eventIds.length);
  });
});
