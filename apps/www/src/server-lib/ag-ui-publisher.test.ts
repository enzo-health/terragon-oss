import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { env } from "@terragon/env/apps-www";
import { createDb } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { eq } from "drizzle-orm";

// Mock the redis module so we can assert XADD calls and simulate failures
// without a live Redis. The DB stays real — this is the whole point of the
// test: prove persist + XADD actually work end-to-end.
const redisMocks = vi.hoisted(() => ({
  xadd: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  redis: redisMocks,
}));

// Import AFTER vi.mock so the publisher picks up the mocked redis.
const {
  persistAndPublishAgUiEvents,
  buildAgUiEventId,
  buildDeltaRunEndRows,
  canonicalEventsToAgUiRows,
  daemonDeltasToAgUiRows,
  dbAgentMessagePartsToAgUiRows,
} = await import("./ag-ui-publisher");

const db = createDb(env.DATABASE_URL);

type RunFixture = {
  runId: string;
  threadId: string;
  threadChatId: string;
};

async function createRunFixture(): Promise<RunFixture> {
  const { user } = await createTestUser({ db });
  const { threadId, threadChatId } = await createTestThread({
    db,
    userId: user.id,
  });
  return {
    runId: `run-${crypto.randomUUID()}`,
    threadId,
    threadChatId,
  };
}

function makeTextStartEvent(messageId: string): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_START,
    timestamp: 1_700_000_000,
    messageId,
    role: "assistant",
  } as BaseEvent;
}
function makeTextContentEvent(messageId: string, delta: string): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_CONTENT,
    timestamp: 1_700_000_000,
    messageId,
    delta,
  } as BaseEvent;
}
function makeTextEndEvent(messageId: string): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_END,
    timestamp: 1_700_000_000,
    messageId,
  } as BaseEvent;
}

async function fetchRowsForThreadChat(threadChatId: string) {
  return db
    .select()
    .from(schema.agentEventLog)
    .where(eq(schema.agentEventLog.threadChatId, threadChatId))
    .orderBy(schema.agentEventLog.seq);
}

describe("ag-ui-publisher", () => {
  beforeEach(async () => {
    await db.delete(schema.agentEventLog);
    vi.clearAllMocks();
    redisMocks.xadd.mockResolvedValue("1-0");
  });

  it("happy path: one canonical event expanding to 3 rows produces 3 inserts and 3 ordered XADDs", async () => {
    const fixture = await createRunFixture();
    const canonicalEventId = "ce-1";
    const messageId = "m-1";

    const rows = [
      {
        event: makeTextStartEvent(messageId),
        eventId: buildAgUiEventId(
          canonicalEventId,
          EventType.TEXT_MESSAGE_START,
          0,
        ),
        timestamp: new Date(),
      },
      {
        event: makeTextContentEvent(messageId, "hello"),
        eventId: buildAgUiEventId(
          canonicalEventId,
          EventType.TEXT_MESSAGE_CONTENT,
          1,
        ),
        timestamp: new Date(),
      },
      {
        event: makeTextEndEvent(messageId),
        eventId: buildAgUiEventId(
          canonicalEventId,
          EventType.TEXT_MESSAGE_END,
          2,
        ),
        timestamp: new Date(),
      },
    ];

    const result = await persistAndPublishAgUiEvents({
      db,
      runId: fixture.runId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      rows,
    });

    expect(result.inserted).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.insertedEventIds).toEqual(rows.map((r) => r.eventId));

    const persisted = await fetchRowsForThreadChat(fixture.threadChatId);
    expect(persisted.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(persisted.map((r) => r.eventId)).toEqual(rows.map((r) => r.eventId));

    expect(redisMocks.xadd).toHaveBeenCalledTimes(3);
    const streamKey = `agui:thread:${fixture.threadChatId}`;
    for (let i = 0; i < 3; i++) {
      const call = redisMocks.xadd.mock.calls[i]!;
      expect(call[0]).toBe(streamKey);
      expect(call[1]).toBe("*");
      const parsed = JSON.parse((call[2] as { event: string }).event);
      expect(parsed.type).toBe(rows[i]!.event.type);
    }
  });

  it("partial duplicate: re-publishing an overlapping batch skips duplicates and re-XADDs only new rows", async () => {
    const fixture = await createRunFixture();
    const messageId = "m-1";

    const firstBatch = canonicalEventsToAgUiRows([
      {
        payloadVersion: 2,
        eventId: "ce-1",
        runId: fixture.runId,
        threadId: fixture.threadId,
        threadChatId: fixture.threadChatId,
        seq: 0,
        timestamp: new Date().toISOString(),
        category: "transcript",
        type: "assistant-message",
        messageId,
        content: "one",
      },
    ]);

    const first = await persistAndPublishAgUiEvents({
      db,
      runId: fixture.runId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      rows: firstBatch,
    });
    expect(first.inserted).toBe(3);
    redisMocks.xadd.mockClear();

    // Re-run the same batch PLUS a new event. The duplicate rows skip, the
    // new row inserts. Only the new row should XADD.
    const secondBatch = [
      ...firstBatch,
      {
        event: makeTextContentEvent(messageId, "extra"),
        eventId: "ce-2:TEXT_MESSAGE_CONTENT:0",
        timestamp: new Date(),
      },
    ];

    const second = await persistAndPublishAgUiEvents({
      db,
      runId: fixture.runId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      rows: secondBatch,
    });

    expect(second.inserted).toBe(1);
    expect(second.skipped).toBe(3);
    expect(second.insertedEventIds).toEqual(["ce-2:TEXT_MESSAGE_CONTENT:0"]);

    // XADD only called for the fresh insert.
    expect(redisMocks.xadd).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(
      (redisMocks.xadd.mock.calls[0]![2] as { event: string }).event,
    );
    expect(payload.delta).toBe("extra");
  });

  it("full duplicate: entire batch already persisted → zero XADDs", async () => {
    const fixture = await createRunFixture();
    const rows = canonicalEventsToAgUiRows([
      {
        payloadVersion: 2,
        eventId: "ce-1",
        runId: fixture.runId,
        threadId: fixture.threadId,
        threadChatId: fixture.threadChatId,
        seq: 0,
        timestamp: new Date().toISOString(),
        category: "transcript",
        type: "assistant-message",
        messageId: "m-1",
        content: "hi",
      },
    ]);

    await persistAndPublishAgUiEvents({
      db,
      runId: fixture.runId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      rows,
    });
    redisMocks.xadd.mockClear();

    const second = await persistAndPublishAgUiEvents({
      db,
      runId: fixture.runId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      rows,
    });

    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(rows.length);
    expect(second.insertedEventIds).toEqual([]);
    expect(redisMocks.xadd).not.toHaveBeenCalled();
  });

  it("XADD failure halts further publishes and logs at error severity (C2 policy)", async () => {
    const fixture = await createRunFixture();
    const rows = canonicalEventsToAgUiRows([
      {
        payloadVersion: 2,
        eventId: "ce-1",
        runId: fixture.runId,
        threadId: fixture.threadId,
        threadChatId: fixture.threadChatId,
        seq: 0,
        timestamp: new Date().toISOString(),
        category: "transcript",
        type: "assistant-message",
        messageId: "m-1",
        content: "hello",
      },
    ]);
    // 3 rows: let call 1 succeed, call 2 throw, call 3 must NOT happen.
    redisMocks.xadd
      .mockResolvedValueOnce("1-0")
      .mockRejectedValueOnce(new Error("redis down"))
      .mockResolvedValue("should-not-be-reached");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await persistAndPublishAgUiEvents({
        db,
        runId: fixture.runId,
        threadId: fixture.threadId,
        threadChatId: fixture.threadChatId,
        rows,
      });

      // DB commit happened for all 3.
      expect(result.inserted).toBe(3);
      const persisted = await fetchRowsForThreadChat(fixture.threadChatId);
      expect(persisted).toHaveLength(3);

      // Only 2 XADD attempts: the successful first, the failing second.
      // The third MUST NOT be attempted.
      expect(redisMocks.xadd).toHaveBeenCalledTimes(2);

      // Error logged at error severity with structured fields.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logMessage = errorSpy.mock.calls[0]![0] as string;
      const logFields = errorSpy.mock.calls[0]![1] as Record<string, unknown>;
      expect(logMessage).toMatch(/XADD failed/);
      expect(logFields).toMatchObject({
        threadChatId: fixture.threadChatId,
        streamKey: `agui:thread:${fixture.threadChatId}`,
        publishedCount: 1,
        remainingCount: 2,
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rich-part rows: persists + XADDs AG-UI events for non-text DBAgentMessage parts", async () => {
    const fixture = await createRunFixture();
    const messageId = `${fixture.runId}:msg:0`;

    // First publish one canonical assistant-message (covers the text) then
    // the rich-part rows for thinking + terminal. This mirrors the route
    // flow: canonical events first, then rich parts.
    const canonicalRows = canonicalEventsToAgUiRows([
      {
        payloadVersion: 2,
        eventId: "ce-1",
        runId: fixture.runId,
        threadId: fixture.threadId,
        threadChatId: fixture.threadChatId,
        seq: 0,
        timestamp: new Date().toISOString(),
        category: "transcript",
        type: "assistant-message",
        messageId,
        content: "hello",
      },
    ]);
    await persistAndPublishAgUiEvents({
      db,
      runId: fixture.runId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      rows: canonicalRows,
    });
    redisMocks.xadd.mockClear();

    const richRows = dbAgentMessagePartsToAgUiRows([
      {
        messageId,
        parts: [
          { type: "text", text: "hello" }, // skipped by the mapper
          { type: "thinking", thinking: "pondering" },
          {
            type: "terminal",
            sandboxId: "sb-1",
            terminalId: "t-1",
            chunks: [],
          },
        ],
      },
    ]);

    // Expect 3 reasoning events + 1 custom event = 4 rows.
    expect(richRows).toHaveLength(4);
    expect(richRows.map((r) => r.event.type)).toEqual([
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.CUSTOM,
    ]);

    const result = await persistAndPublishAgUiEvents({
      db,
      runId: fixture.runId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      rows: richRows,
    });

    expect(result.inserted).toBe(4);
    expect(result.skipped).toBe(0);
    expect(redisMocks.xadd).toHaveBeenCalledTimes(4);

    // Verify persistence alongside the canonical rows.
    const persisted = await fetchRowsForThreadChat(fixture.threadChatId);
    expect(persisted).toHaveLength(7); // 3 canonical + 4 rich
    const customRow = persisted.find(
      (r) => r.eventType === String(EventType.CUSTOM),
    );
    expect(customRow).toBeTruthy();
    const customPayload = customRow!.payloadJson as unknown as {
      name: string;
      value: { messageId: string; partIndex: number; part: { type: string } };
    };
    expect(customPayload.name).toBe("terragon.part.terminal");
    expect(customPayload.value.messageId).toBe(messageId);
    expect(customPayload.value.partIndex).toBe(2);
    expect(customPayload.value.part.type).toBe("terminal");
  });

  it("rich-part rows: republishing the same batch is idempotent (dedupe on eventId)", async () => {
    const fixture = await createRunFixture();
    const messageId = `${fixture.runId}:msg:0`;
    const richRows = dbAgentMessagePartsToAgUiRows([
      {
        messageId,
        parts: [{ type: "thinking", thinking: "x" }],
      },
    ]);

    const first = await persistAndPublishAgUiEvents({
      db,
      runId: fixture.runId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      rows: richRows,
    });
    expect(first.inserted).toBe(3);

    redisMocks.xadd.mockClear();
    const second = await persistAndPublishAgUiEvents({
      db,
      runId: fixture.runId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      rows: richRows,
    });
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(3);
    expect(redisMocks.xadd).not.toHaveBeenCalled();
  });

  it("rich-part rows: empty input produces no rows", () => {
    expect(dbAgentMessagePartsToAgUiRows([])).toEqual([]);
    expect(
      dbAgentMessagePartsToAgUiRows([{ messageId: "m", parts: [] }]),
    ).toEqual([]);
    expect(
      dbAgentMessagePartsToAgUiRows([
        { messageId: "m", parts: [{ type: "text", text: "only text" }] },
      ]),
    ).toEqual([]);
  });

  it("daemonDeltasToAgUiRows: prepends exactly one synthetic START per (messageId, kind) within the batch", () => {
    const runId = "run-delta-1";
    const rows = daemonDeltasToAgUiRows({
      runId,
      deltas: [
        {
          messageId: "m-1",
          partIndex: 0,
          deltaSeq: 0,
          kind: "text",
          text: "a",
        },
        {
          messageId: "m-1",
          partIndex: 0,
          deltaSeq: 1,
          kind: "text",
          text: "b",
        },
        {
          messageId: "m-1",
          partIndex: 0,
          deltaSeq: 2,
          kind: "thinking",
          text: "t1",
        },
        {
          messageId: "m-2",
          partIndex: 0,
          deltaSeq: 0,
          kind: "text",
          text: "c",
        },
      ],
    });

    // Expect interleaved STARTs prepended at first occurrence of each pair:
    //   [TEXT_START(m-1), TEXT_CONTENT(m-1,"a"), TEXT_CONTENT(m-1,"b"),
    //    REASONING_START(m-1), REASONING_CONTENT(m-1,"t1"),
    //    TEXT_START(m-2), TEXT_CONTENT(m-2,"c")]
    expect(rows.map((r) => r.event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);

    // Synthetic START eventIds are deterministic and distinguishable from
    // content eventIds.
    const startRows = rows.filter(
      (r) =>
        r.event.type === EventType.TEXT_MESSAGE_START ||
        r.event.type === EventType.REASONING_MESSAGE_START,
    );
    expect(startRows.map((r) => r.eventId)).toEqual([
      `delta-start:${runId}:m-1:text`,
      `delta-start:${runId}:m-1:thinking`,
      `delta-start:${runId}:m-2:text`,
    ]);
  });

  it("daemonDeltasToAgUiRows: persisting two batches deduplicates the synthetic START via (runId, eventId)", async () => {
    const fixture = await createRunFixture();
    const firstBatch = daemonDeltasToAgUiRows({
      runId: fixture.runId,
      deltas: [
        {
          messageId: "m-x",
          partIndex: 0,
          deltaSeq: 0,
          kind: "text",
          text: "a",
        },
      ],
    });
    await persistAndPublishAgUiEvents({
      db,
      runId: fixture.runId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      rows: firstBatch,
    });

    const secondBatch = daemonDeltasToAgUiRows({
      runId: fixture.runId,
      deltas: [
        {
          messageId: "m-x",
          partIndex: 0,
          deltaSeq: 1,
          kind: "text",
          text: "b",
        },
      ],
    });
    redisMocks.xadd.mockClear();
    const result = await persistAndPublishAgUiEvents({
      db,
      runId: fixture.runId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      rows: secondBatch,
    });

    // Second batch tries to re-insert the same synthetic START (dedupe on
    // (runId, eventId)) plus one new CONTENT row. Only the CONTENT inserts.
    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.insertedEventIds).toEqual([
      `delta:${fixture.runId}:m-x:0:text:1`,
    ]);

    const persisted = await fetchRowsForThreadChat(fixture.threadChatId);
    // 1 synthetic START + 2 CONTENT rows total across both batches.
    expect(persisted.map((r) => r.eventType)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
  });

  it("buildDeltaRunEndRows: produces END rows with deterministic eventIds for each open message", () => {
    const runId = "run-end-1";
    const endRows = buildDeltaRunEndRows({
      runId,
      openMessages: [
        { messageId: "m-1", kind: "text" },
        { messageId: "m-2", kind: "thinking" },
      ],
    });
    expect(endRows.map((r) => r.event.type)).toEqual([
      EventType.TEXT_MESSAGE_END,
      EventType.REASONING_MESSAGE_END,
    ]);
    expect(endRows.map((r) => r.eventId)).toEqual([
      `delta-end:${runId}:m-1:text`,
      `delta-end:${runId}:m-2:thinking`,
    ]);
  });

  it("seq continuity: two sequential calls for same threadChatId produce contiguous seqs", async () => {
    const fixture = await createRunFixture();

    const firstRows = canonicalEventsToAgUiRows([
      {
        payloadVersion: 2,
        eventId: "ce-1",
        runId: fixture.runId,
        threadId: fixture.threadId,
        threadChatId: fixture.threadChatId,
        seq: 0,
        timestamp: new Date().toISOString(),
        category: "transcript",
        type: "assistant-message",
        messageId: "m-1",
        content: "first",
      },
    ]);
    await persistAndPublishAgUiEvents({
      db,
      runId: fixture.runId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      rows: firstRows,
    });

    const secondRows = canonicalEventsToAgUiRows([
      {
        payloadVersion: 2,
        eventId: "ce-2",
        runId: fixture.runId,
        threadId: fixture.threadId,
        threadChatId: fixture.threadChatId,
        seq: 1,
        timestamp: new Date().toISOString(),
        category: "transcript",
        type: "assistant-message",
        messageId: "m-2",
        content: "second",
      },
    ]);
    await persistAndPublishAgUiEvents({
      db,
      runId: fixture.runId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      rows: secondRows,
    });

    const persisted = await fetchRowsForThreadChat(fixture.threadChatId);
    // 3 rows per batch (START / CONTENT / END) × 2 batches = 6 rows,
    // contiguous seqs 0..5.
    expect(persisted.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
