import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import { env } from "@terragon/env/pkg-shared";
import type {
  AssistantMessageEvent,
  OperationalRunStartedEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@terragon/agent/canonical-events";
import { EVENT_ENVELOPE_VERSION } from "@terragon/agent/canonical-events";
import { createDb } from "../db";
import * as schema from "../db/schema";
import type { AgentEventLog as AgentEventLogRow } from "../db/types";
import { createTestThread, createTestUser } from "./test-helpers";
import {
  appendCanonicalEvent,
  appendCanonicalEventsBatch,
  assignThreadChatMessageSeqToCanonicalEvents,
  getAgUiEventsForRun,
  getLatestRunIdForThreadChat,
  getThreadReplayEntriesFromCanonicalEvents,
  getRunEvents,
  getRunMaxSeq,
  hasCanonicalReplayProjection,
  peekNextThreadChatSeqLocked,
  readAgUiPayload,
  validateCanonicalEnvelope,
  validateCanonicalEvent,
} from "./agent-event-log";

const db = createDb(env.DATABASE_URL!);

type RunFixture = {
  runId: string;
  threadId: string;
  threadChatId: string;
};

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function createRunFixture(): Promise<RunFixture> {
  const { user } = await createTestUser({ db });
  const { threadId, threadChatId } = await createTestThread({
    db,
    userId: user.id,
  });

  return {
    runId: newId("run"),
    threadId,
    threadChatId,
  };
}

function createRunStartedEvent({
  runId,
  threadId,
  threadChatId,
  seq = 0,
  eventId = newId("event"),
  idempotencyKey,
}: RunFixture & {
  seq?: number;
  eventId?: string;
  idempotencyKey?: string;
}): OperationalRunStartedEvent {
  return {
    payloadVersion: EVENT_ENVELOPE_VERSION,
    eventId,
    runId,
    threadId,
    threadChatId,
    seq,
    timestamp: new Date().toISOString(),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    category: "operational",
    type: "run-started",
    agent: "codex",
    model: "gpt-5.4",
    transportMode: "legacy",
    protocolVersion: 2,
  };
}

function createAssistantMessageEvent({
  runId,
  threadId,
  threadChatId,
  seq,
  eventId = newId("event"),
}: RunFixture & {
  seq: number;
  eventId?: string;
}): AssistantMessageEvent {
  return {
    payloadVersion: EVENT_ENVELOPE_VERSION,
    eventId,
    runId,
    threadId,
    threadChatId,
    seq,
    timestamp: new Date().toISOString(),
    category: "transcript",
    type: "assistant-message",
    messageId: newId("message"),
    content: "hello",
  };
}

function createToolCallStartEvent({
  runId,
  threadId,
  threadChatId,
  seq,
}: RunFixture & {
  seq: number;
}): ToolCallStartEvent {
  return {
    payloadVersion: EVENT_ENVELOPE_VERSION,
    eventId: newId("event"),
    runId,
    threadId,
    threadChatId,
    seq,
    timestamp: new Date().toISOString(),
    category: "tool_lifecycle",
    type: "tool-call-start",
    toolCallId: newId("tool"),
    name: "bash",
    parameters: { command: "ls -la" },
  };
}

function createToolCallResultEvent({
  runId,
  threadId,
  threadChatId,
  seq,
}: RunFixture & {
  seq: number;
}): ToolCallResultEvent {
  return {
    payloadVersion: EVENT_ENVELOPE_VERSION,
    eventId: newId("event"),
    runId,
    threadId,
    threadChatId,
    seq,
    timestamp: new Date().toISOString(),
    category: "tool_lifecycle",
    type: "tool-call-result",
    toolCallId: newId("tool"),
    result: "done",
    isError: false,
    completedAt: new Date().toISOString(),
  };
}

describe("agent-event-log", () => {
  beforeEach(async () => {
    await db.delete(schema.agentEventLog);
  });

  it("validates a canonical envelope without idempotencyKey", async () => {
    const fixture = await createRunFixture();
    const result = validateCanonicalEnvelope({
      payloadVersion: EVENT_ENVELOPE_VERSION,
      eventId: newId("event"),
      runId: fixture.runId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      seq: 0,
      timestamp: new Date().toISOString(),
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.envelope.idempotencyKey).toBeUndefined();
    }
  });

  it("extracts envelope fields from a full canonical event", async () => {
    const fixture = await createRunFixture();
    const event = createRunStartedEvent(fixture);
    const result = validateCanonicalEnvelope(event);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.envelope.eventId).toBe(event.eventId);
      expect(result.envelope.runId).toBe(event.runId);
      expect(result.envelope.threadId).toBe(event.threadId);
    }
  });

  it("validates a representative run-started event", async () => {
    const fixture = await createRunFixture();
    const event = createRunStartedEvent(fixture);
    const result = validateCanonicalEvent(event);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.event.type).toBe("run-started");
      expect(result.event.runId).toBe(fixture.runId);
    }
  });

  it("inserts once and deduplicates repeated events", async () => {
    const fixture = await createRunFixture();
    const event = createRunStartedEvent(fixture);

    const first = await appendCanonicalEvent({ db, event });
    expect(first).toMatchObject({
      success: true,
      inserted: true,
      eventId: event.eventId,
      runId: event.runId,
      seq: event.seq,
    });

    const second = await appendCanonicalEvent({ db, event });
    expect(second).toMatchObject({
      success: true,
      inserted: false,
      deduplicated: true,
      eventId: event.eventId,
      runId: event.runId,
      seq: event.seq,
    });

    const storedEvents = await getRunEvents({ db, runId: fixture.runId });
    expect(storedEvents).toHaveLength(1);
    expect(storedEvents[0]?.idempotencyKey).toBe(
      `${event.runId}:${event.eventId}`,
    );
  });

  it("rejects sequence collisions for a different event in the same run", async () => {
    const fixture = await createRunFixture();
    const first = createRunStartedEvent(fixture);
    const second = createAssistantMessageEvent({
      ...fixture,
      seq: first.seq,
    });

    const firstResult = await appendCanonicalEvent({ db, event: first });
    expect(firstResult).toMatchObject({ success: true, inserted: true });

    const secondResult = await appendCanonicalEvent({ db, event: second });
    expect(secondResult).toMatchObject({
      success: false,
      code: "seq_violation",
    });
  });

  it("keeps batch append atomic when a later event fails", async () => {
    const fixture = await createRunFixture();
    const first = createRunStartedEvent(fixture);
    const second = createAssistantMessageEvent({
      ...fixture,
      seq: first.seq,
    });

    const result = await appendCanonicalEventsBatch({
      db,
      events: [first, second],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      success: false,
      code: "seq_violation",
    });

    const storedEvents = await getRunEvents({ db, runId: fixture.runId });
    expect(storedEvents).toHaveLength(0);
  });

  it("returns ordered run events and the current max seq", async () => {
    const fixture = await createRunFixture();
    const events = [
      createRunStartedEvent({ ...fixture, seq: 0 }),
      createAssistantMessageEvent({ ...fixture, seq: 1 }),
      createToolCallStartEvent({ ...fixture, seq: 2 }),
    ];

    const result = await appendCanonicalEventsBatch({ db, events });
    expect(result).toHaveLength(3);
    expect(result.every((entry) => entry.success)).toBe(true);

    const allEvents = await getRunEvents({ db, runId: fixture.runId });
    expect(allEvents.map((entry) => entry.seq)).toEqual([0, 1, 2]);

    const replayEvents = await getRunEvents({
      db,
      runId: fixture.runId,
      fromSeq: 1,
    });
    expect(replayEvents.map((entry) => entry.seq)).toEqual([1, 2]);

    const maxSeq = await getRunMaxSeq({ db, runId: fixture.runId });
    expect(maxSeq).toBe(2);
  });

  it("assigns replay sequences and projects replay entries in message order", async () => {
    const fixture = await createRunFixture();
    const firstBatch = [
      createRunStartedEvent({ ...fixture, seq: 0 }),
      createAssistantMessageEvent({ ...fixture, seq: 1 }),
      createToolCallStartEvent({ ...fixture, seq: 2 }),
    ];
    const secondBatch = [
      createToolCallResultEvent({ ...fixture, seq: 3 }),
      createAssistantMessageEvent({ ...fixture, seq: 4 }),
    ];

    await appendCanonicalEventsBatch({
      db,
      events: [...firstBatch, ...secondBatch],
    });

    expect(
      await hasCanonicalReplayProjection({
        db,
        threadId: fixture.threadId,
      }),
    ).toBe(false);

    await assignThreadChatMessageSeqToCanonicalEvents({
      db,
      eventIds: firstBatch.map((event) => event.eventId),
      threadChatMessageSeq: 6,
    });
    await assignThreadChatMessageSeqToCanonicalEvents({
      db,
      eventIds: secondBatch.map((event) => event.eventId),
      threadChatMessageSeq: 7,
    });

    expect(
      await hasCanonicalReplayProjection({
        db,
        threadId: fixture.threadId,
      }),
    ).toBe(true);

    const replayEntries = await getThreadReplayEntriesFromCanonicalEvents({
      db,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      fromThreadChatMessageSeq: 5,
    });

    expect(replayEntries).toEqual([
      {
        seq: 6,
        messages: [
          expect.objectContaining({
            type: "agent",
            parts: [{ type: "text", text: "hello" }],
          }),
          expect.objectContaining({
            type: "tool-call",
            name: "bash",
          }),
        ],
      },
      {
        seq: 7,
        messages: [
          expect.objectContaining({
            type: "tool-result",
            result: "done",
          }),
          expect.objectContaining({
            type: "agent",
            parts: [{ type: "text", text: "hello" }],
          }),
        ],
      },
    ]);
  });

  it("treats a missing agent_event_log relation as no canonical replay projection", async () => {
    const fixture = await createRunFixture();
    const findFirstSpy = vi
      .spyOn(db.query.agentEventLog, "findFirst")
      .mockRejectedValue(
        Object.assign(new Error('relation "agent_event_log" does not exist'), {
          code: "42P01",
        }),
      );

    try {
      await expect(
        hasCanonicalReplayProjection({
          db,
          threadId: fixture.threadId,
          threadChatId: fixture.threadChatId,
        }),
      ).resolves.toBe(false);
    } finally {
      findFirstSpy.mockRestore();
    }
  });

  it("returns no replay entries when the agent_event_log relation is unavailable", async () => {
    const fixture = await createRunFixture();
    const findManySpy = vi
      .spyOn(db.query.agentEventLog, "findMany")
      .mockRejectedValue(
        Object.assign(new Error('relation "agent_event_log" does not exist'), {
          code: "42P01",
        }),
      );

    try {
      await expect(
        getThreadReplayEntriesFromCanonicalEvents({
          db,
          threadId: fixture.threadId,
          threadChatId: fixture.threadChatId,
          fromThreadChatMessageSeq: 0,
        }),
      ).resolves.toEqual([]);
    } finally {
      findManySpy.mockRestore();
    }
  });

  describe("readAgUiPayload", () => {
    function makeRow(
      payloadJson: Record<string, unknown>,
      overrides: Partial<AgentEventLogRow> = {},
    ): AgentEventLogRow {
      const now = new Date();
      return {
        id: newId("row"),
        logSeq: 1,
        eventId: newId("event"),
        runId: newId("run"),
        threadId: newId("thread"),
        threadChatId: newId("thread-chat"),
        seq: 0,
        eventType: "unknown",
        category: "operational",
        payloadJson,
        idempotencyKey: newId("idempotency"),
        timestamp: now,
        threadChatMessageSeq: null,
        createdAt: now,
        ...overrides,
      } as AgentEventLogRow;
    }

    it("returns an AG-UI BaseEvent unchanged when payload is already AG-UI shape", () => {
      const agUiEvent: Record<string, unknown> = {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: 1_700_000_000_000,
        messageId: "msg-1",
        delta: "hello world",
      };
      const row = makeRow(agUiEvent, { eventType: "TEXT_MESSAGE_CONTENT" });

      const result = readAgUiPayload(row);
      expect(result).toEqual(agUiEvent);
      expect(result?.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    });

    it("maps an envelope-v2 canonical event row to its first AG-UI event", async () => {
      const fixture = await createRunFixture();
      const canonicalEvent = createAssistantMessageEvent({
        ...fixture,
        seq: 1,
      });
      const row = makeRow(
        canonicalEvent as unknown as Record<string, unknown>,
        {
          eventType: canonicalEvent.type,
          category: canonicalEvent.category,
        },
      );

      const result = readAgUiPayload(row);

      // assistant-message expands to TEXT_MESSAGE_START + _CONTENT + _END;
      // the shim returns the first (START).
      expect(result).not.toBeNull();
      expect(result?.type).toBe(EventType.TEXT_MESSAGE_START);
      expect((result as { messageId?: string } | null)?.messageId).toBe(
        canonicalEvent.messageId,
      );
    });

    it("returns null and warns when the payload matches neither shape", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const row = makeRow({ garbage: true, nothing: "useful" });
        const result = readAgUiPayload(row);
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("peekNextThreadChatSeqLocked", () => {
    it("returns 0 when no prior events exist for the thread chat", async () => {
      const fixture = await createRunFixture();
      const seq = await db.transaction(async (tx) =>
        peekNextThreadChatSeqLocked({
          tx,
          threadChatId: fixture.threadChatId,
          count: 1,
        }),
      );
      expect(seq).toBe(0);
    });

    it("returns the next seq after existing events", async () => {
      const fixture = await createRunFixture();
      await appendCanonicalEventsBatch({
        db,
        events: [
          createRunStartedEvent({ ...fixture, seq: 0 }),
          createAssistantMessageEvent({ ...fixture, seq: 1 }),
        ],
      });
      const seq = await db.transaction(async (tx) =>
        peekNextThreadChatSeqLocked({
          tx,
          threadChatId: fixture.threadChatId,
          count: 1,
        }),
      );
      expect(seq).toBe(2);
    });

    it("documents the peek-without-insert contract", async () => {
      // The function is a peek inside a lock — two concurrent callers that
      // peek without inserting both observe MAX=NULL and return 0. This
      // test pins the invariant: the caller MUST insert rows inside the
      // same transaction to advance the counter. See the JSDoc on
      // peekNextThreadChatSeqLocked for the full contract.
      const fixture = await createRunFixture();
      const [seqA, seqB] = await Promise.all([
        db.transaction(async (tx) =>
          peekNextThreadChatSeqLocked({
            tx,
            threadChatId: fixture.threadChatId,
            count: 1,
          }),
        ),
        db.transaction(async (tx) =>
          peekNextThreadChatSeqLocked({
            tx,
            threadChatId: fixture.threadChatId,
            count: 1,
          }),
        ),
      ]);
      expect(seqA).toBe(0);
      expect(seqB).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Phase A: `getAgUiEventsForRun` — "Replay from Run Start" helper.
  // -------------------------------------------------------------------
  describe("getAgUiEventsForRun", () => {
    async function insertAgUiRow({
      fixture,
      seq,
      payload,
      eventType,
      category = "agui",
    }: {
      fixture: RunFixture;
      seq: number;
      payload: Record<string, unknown>;
      eventType: string;
      category?: string;
    }): Promise<void> {
      const now = new Date();
      await db.insert(schema.agentEventLog).values({
        eventId: newId("event"),
        runId: fixture.runId,
        threadId: fixture.threadId,
        threadChatId: fixture.threadChatId,
        seq,
        eventType,
        category,
        payloadJson: payload,
        idempotencyKey: newId("idempotency"),
        timestamp: now,
      });
    }

    it("returns all AG-UI events for the run in seq ascending order", async () => {
      const fixture = await createRunFixture();
      // Insert out of seq order to verify the helper sorts.
      await insertAgUiRow({
        fixture,
        seq: 2,
        eventType: "TEXT_MESSAGE_END",
        payload: {
          type: EventType.TEXT_MESSAGE_END,
          timestamp: 2,
          messageId: "m-1",
        },
      });
      await insertAgUiRow({
        fixture,
        seq: 0,
        eventType: "RUN_STARTED",
        payload: {
          type: EventType.RUN_STARTED,
          timestamp: 0,
          threadId: fixture.threadChatId,
          runId: fixture.runId,
        },
      });
      await insertAgUiRow({
        fixture,
        seq: 1,
        eventType: "TEXT_MESSAGE_START",
        payload: {
          type: EventType.TEXT_MESSAGE_START,
          timestamp: 1,
          messageId: "m-1",
          role: "assistant",
        },
      });

      const events = await getAgUiEventsForRun({
        db,
        runId: fixture.runId,
      });
      expect(events).toHaveLength(3);
      expect(events[0]?.type).toBe(EventType.RUN_STARTED);
      expect(events[1]?.type).toBe(EventType.TEXT_MESSAGE_START);
      expect(events[2]?.type).toBe(EventType.TEXT_MESSAGE_END);
    });

    it("filters events by runId — other runs in the same thread chat are excluded", async () => {
      const fixture = await createRunFixture();
      const otherRunId = newId("run");

      await insertAgUiRow({
        fixture,
        seq: 0,
        eventType: "RUN_STARTED",
        payload: {
          type: EventType.RUN_STARTED,
          timestamp: 0,
          threadId: fixture.threadChatId,
          runId: fixture.runId,
        },
      });
      // Same thread chat but a different run. Must NOT appear in results.
      await db.insert(schema.agentEventLog).values({
        eventId: newId("event"),
        runId: otherRunId,
        threadId: fixture.threadId,
        threadChatId: fixture.threadChatId,
        seq: 1,
        eventType: "RUN_STARTED",
        category: "agui",
        payloadJson: {
          type: EventType.RUN_STARTED,
          timestamp: 1,
          threadId: fixture.threadChatId,
          runId: otherRunId,
        },
        idempotencyKey: newId("idempotency"),
        timestamp: new Date(),
      });

      const events = await getAgUiEventsForRun({
        db,
        runId: fixture.runId,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: EventType.RUN_STARTED,
        runId: fixture.runId,
      });
    });

    it("expands canonical-event rows via readAllAgUiPayloads (START + CONTENT + END)", async () => {
      const fixture = await createRunFixture();
      // Canonical assistant-message — expands to START + CONTENT + END.
      const canonical = createAssistantMessageEvent({ ...fixture, seq: 1 });
      await db.insert(schema.agentEventLog).values({
        eventId: canonical.eventId,
        runId: canonical.runId,
        threadId: canonical.threadId,
        threadChatId: canonical.threadChatId,
        seq: canonical.seq,
        eventType: canonical.type,
        category: canonical.category,
        payloadJson: canonical as unknown as Record<string, unknown>,
        idempotencyKey: canonical.eventId,
        timestamp: new Date(),
      });

      const events = await getAgUiEventsForRun({
        db,
        runId: fixture.runId,
      });
      // assistant-message → TEXT_MESSAGE_START + _CONTENT + _END.
      expect(events.map((e) => e.type)).toEqual([
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
      ]);
    });

    it("returns [] when the agent_event_log relation is unavailable", async () => {
      const findManySpy = vi
        .spyOn(db.query.agentEventLog, "findMany")
        .mockRejectedValue(
          Object.assign(
            new Error('relation "agent_event_log" does not exist'),
            {
              code: "42P01",
            },
          ),
        );
      try {
        await expect(
          getAgUiEventsForRun({ db, runId: "missing-run" }),
        ).resolves.toEqual([]);
      } finally {
        findManySpy.mockRestore();
      }
    });

    it("returns [] for a run with no events", async () => {
      await expect(
        getAgUiEventsForRun({ db, runId: "definitely-not-a-real-run" }),
      ).resolves.toEqual([]);
    });
  });

  describe("getLatestRunIdForThreadChat", () => {
    it("returns the runId of the highest-seq row for the thread chat", async () => {
      const fixture = await createRunFixture();
      const laterRunId = newId("run");

      await db.insert(schema.agentEventLog).values([
        {
          eventId: newId("event"),
          runId: fixture.runId,
          threadId: fixture.threadId,
          threadChatId: fixture.threadChatId,
          seq: 0,
          eventType: "RUN_STARTED",
          category: "agui",
          payloadJson: {
            type: EventType.RUN_STARTED,
            runId: fixture.runId,
          },
          idempotencyKey: newId("idempotency"),
          timestamp: new Date(),
        },
        {
          eventId: newId("event"),
          runId: laterRunId,
          threadId: fixture.threadId,
          threadChatId: fixture.threadChatId,
          seq: 3,
          eventType: "RUN_STARTED",
          category: "agui",
          payloadJson: { type: EventType.RUN_STARTED, runId: laterRunId },
          idempotencyKey: newId("idempotency"),
          timestamp: new Date(),
        },
      ]);

      await expect(
        getLatestRunIdForThreadChat({
          db,
          threadChatId: fixture.threadChatId,
        }),
      ).resolves.toBe(laterRunId);
    });

    it("returns null when the thread chat has no events", async () => {
      await expect(
        getLatestRunIdForThreadChat({
          db,
          threadChatId: "chat-with-no-events",
        }),
      ).resolves.toBeNull();
    });
  });
});
