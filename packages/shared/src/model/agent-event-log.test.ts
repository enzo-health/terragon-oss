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
  getThreadReplayEntriesFromCanonicalEvents,
  getAgUiEventsForReplay,
  getRunEvents,
  getRunMaxSeq,
  hasCanonicalReplayProjection,
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

  it("getAgUiEventsForReplay returns [] when the agent_event_log relation is unavailable", async () => {
    const findManySpy = vi
      .spyOn(db.query.agentEventLog, "findMany")
      .mockRejectedValue(
        Object.assign(new Error('relation "agent_event_log" does not exist'), {
          code: "42P01",
        }),
      );

    try {
      await expect(
        getAgUiEventsForReplay({
          db,
          threadChatId: "missing-chat",
          fromSeq: 0,
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
});
