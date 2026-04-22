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
  broadcastAgUiEventEphemeral,
  buildAgUiEventId,
  buildDeltaRunEndRows,
  buildRunTerminalAgUi,
  canonicalEventsToAgUiRows,
  daemonDeltasToAgUiRows,
  dbAgentMessagePartsToAgUiRows,
  metaEventsToAgUiEvents,
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

  // -------------------------------------------------------------------
  // buildAgUiEventId — format invariant + collision safety
  // -------------------------------------------------------------------

  describe("buildAgUiEventId", () => {
    it("produces canonical:type:index format", () => {
      expect(buildAgUiEventId("ce-1", "TEXT_MESSAGE_START", 0)).toBe(
        "ce-1:TEXT_MESSAGE_START:0",
      );
    });

    it("expansion index prevents collision for same-type events", () => {
      const id0 = buildAgUiEventId("ce-1", "TOOL_CALL_ARGS", 0);
      const id1 = buildAgUiEventId("ce-1", "TOOL_CALL_ARGS", 1);
      expect(id0).not.toBe(id1);
      expect(id0).toBe("ce-1:TOOL_CALL_ARGS:0");
      expect(id1).toBe("ce-1:TOOL_CALL_ARGS:1");
    });

    it("different event types from same source produce different ids", () => {
      const start = buildAgUiEventId("ce-1", "TEXT_MESSAGE_START", 0);
      const content = buildAgUiEventId("ce-1", "TEXT_MESSAGE_CONTENT", 0);
      expect(start).not.toBe(content);
    });
  });

  // -------------------------------------------------------------------
  // buildRunTerminalAgUi — status dispatch logic
  // -------------------------------------------------------------------

  describe("buildRunTerminalAgUi", () => {
    it("maps completed → RUN_FINISHED", () => {
      const event = buildRunTerminalAgUi({
        threadId: "t-1",
        runId: "r-1",
        daemonRunStatus: "completed",
        errorMessage: null,
      });
      expect(event.type).toBe(EventType.RUN_FINISHED);
      expect((event as Record<string, unknown>).threadId).toBe("t-1");
      expect((event as Record<string, unknown>).runId).toBe("r-1");
      expect(event).not.toHaveProperty("result");
    });

    it("maps stopped → RUN_FINISHED with stopped marker", () => {
      const event = buildRunTerminalAgUi({
        threadId: "t-1",
        runId: "r-1",
        daemonRunStatus: "stopped",
        errorMessage: null,
      });
      expect(event.type).toBe(EventType.RUN_FINISHED);
      expect((event as Record<string, unknown>).result).toEqual({
        stopped: true,
      });
    });

    it("maps failed → RUN_ERROR with error message", () => {
      const event = buildRunTerminalAgUi({
        threadId: "t-1",
        runId: "r-1",
        daemonRunStatus: "failed",
        errorMessage: "context too long",
      });
      expect(event.type).toBe(EventType.RUN_ERROR);
      expect((event as Record<string, unknown>).message).toBe(
        "context too long",
      );
    });

    it("defaults error message to 'Run failed' when null", () => {
      const event = buildRunTerminalAgUi({
        threadId: "t-1",
        runId: "r-1",
        daemonRunStatus: "failed",
        errorMessage: null,
      });
      expect(event.type).toBe(EventType.RUN_ERROR);
      expect((event as Record<string, unknown>).message).toBe("Run failed");
    });

    it("passes errorCode through when provided", () => {
      const event = buildRunTerminalAgUi({
        threadId: "t-1",
        runId: "r-1",
        daemonRunStatus: "failed",
        errorMessage: "rate limited",
        errorCode: "RATE_LIMIT",
      });
      expect((event as Record<string, unknown>).code).toBe("RATE_LIMIT");
    });
  });

  // -------------------------------------------------------------------
  // broadcastAgUiEventEphemeral — fire-and-forget XADD
  // -------------------------------------------------------------------

  describe("broadcastAgUiEventEphemeral", () => {
    it("XADDs a single event to the stream key without DB persistence", async () => {
      const event = {
        type: EventType.RUN_FINISHED,
        timestamp: Date.now(),
        threadId: "t-1",
        runId: "r-1",
      } as BaseEvent;

      await broadcastAgUiEventEphemeral({
        threadChatId: "tc-ephemeral",
        event,
      });

      expect(redisMocks.xadd).toHaveBeenCalledTimes(1);
      const [streamKey, id, data] = redisMocks.xadd.mock.calls[0]!;
      expect(streamKey).toBe("agui:thread:tc-ephemeral");
      expect(id).toBe("*");
      const parsed = JSON.parse((data as { event: string }).event);
      expect(parsed.type).toBe(EventType.RUN_FINISHED);
    });

    it("logs error without crashing on XADD failure", async () => {
      redisMocks.xadd.mockRejectedValueOnce(new Error("redis timeout"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await broadcastAgUiEventEphemeral({
          threadChatId: "tc-fail",
          event: {
            type: EventType.CUSTOM,
            timestamp: Date.now(),
            name: "test",
            value: {},
          } as BaseEvent,
        });
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0]![0]).toMatch(/ephemeral XADD failed/);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------
  // metaEventsToAgUiEvents — CUSTOM event conversion
  // -------------------------------------------------------------------

  describe("metaEventsToAgUiEvents", () => {
    it("converts meta events to CUSTOM AG-UI events preserving kind as name", () => {
      const events = metaEventsToAgUiEvents([
        {
          kind: "thread.token_usage_updated",
          usage: { input: 100 },
        } as never,
        { kind: "thread.rate_limit", remaining: 5 } as never,
      ]);

      expect(events).toHaveLength(2);
      expect(events[0]!.type).toBe(EventType.CUSTOM);
      expect((events[0] as Record<string, unknown>).name).toBe(
        "thread.token_usage_updated",
      );
      expect(events[1]!.type).toBe(EventType.CUSTOM);
      expect((events[1] as Record<string, unknown>).name).toBe(
        "thread.rate_limit",
      );
    });
  });

  // -------------------------------------------------------------------
  // Empty batch early-return
  // -------------------------------------------------------------------

  it("empty batch returns zero counts without DB or Redis calls", async () => {
    const fixture = await createRunFixture();
    const result = await persistAndPublishAgUiEvents({
      db,
      runId: fixture.runId,
      threadId: fixture.threadId,
      threadChatId: fixture.threadChatId,
      rows: [],
    });

    expect(result).toEqual({
      inserted: 0,
      skipped: 0,
      insertedEventIds: [],
    });
    expect(redisMocks.xadd).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // Daemon delta content eventId format contract
  // -------------------------------------------------------------------

  it("daemon delta content eventIds encode runId:messageId:partIndex:kind:deltaSeq", () => {
    const rows = daemonDeltasToAgUiRows({
      runId: "run-fmt",
      deltas: [
        {
          messageId: "m-fmt",
          partIndex: 2,
          deltaSeq: 7,
          kind: "thinking",
          text: "x",
        },
      ],
    });
    const contentRow = rows.find(
      (r) => r.event.type === EventType.REASONING_MESSAGE_CONTENT,
    );
    expect(contentRow!.eventId).toBe("delta:run-fmt:m-fmt:2:thinking:7");
  });

  // -------------------------------------------------------------------
  // Daemon delta: mixed text+thinking in same batch
  // -------------------------------------------------------------------

  it("daemon deltas: mixed text+thinking for same messageId get separate STARTs", () => {
    const rows = daemonDeltasToAgUiRows({
      runId: "run-mix",
      deltas: [
        {
          messageId: "m-1",
          partIndex: 0,
          deltaSeq: 0,
          kind: "text",
          text: "hello",
        },
        {
          messageId: "m-1",
          partIndex: 1,
          deltaSeq: 0,
          kind: "thinking",
          text: "hmm",
        },
      ],
    });

    const types = rows.map((r) => r.event.type);
    expect(types).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
    ]);

    const startEventIds = rows
      .filter(
        (r) =>
          r.event.type === EventType.TEXT_MESSAGE_START ||
          r.event.type === EventType.REASONING_MESSAGE_START,
      )
      .map((r) => r.eventId);
    expect(startEventIds).toEqual([
      "delta-start:run-mix:m-1:text",
      "delta-start:run-mix:m-1:thinking",
    ]);
  });

  // -------------------------------------------------------------------
  // Timestamp preservation through row conversion
  // -------------------------------------------------------------------

  it("timestamps are preserved through row conversion", () => {
    const ts = new Date("2026-01-15T12:00:00Z");
    const rows = canonicalEventsToAgUiRows([
      {
        payloadVersion: 2,
        eventId: "ce-ts",
        runId: "run-ts",
        threadId: "thread-ts",
        threadChatId: "tc-ts",
        seq: 0,
        timestamp: ts.toISOString(),
        category: "transcript",
        type: "assistant-message",
        messageId: "m-ts",
        content: "test",
      },
    ]);

    for (const row of rows) {
      expect(row.timestamp.getTime()).toBe(ts.getTime());
    }
  });
});
