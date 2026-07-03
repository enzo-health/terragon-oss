import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerragonDaemon } from "./daemon";
import {
  OutboxJournal,
  parseJournalBuffer,
  selectUnackedEvents,
} from "./outbox-journal";
import { DaemonRuntime } from "./runtime";
import type { DaemonEventAPIBody } from "./shared";

function makeBody(
  overrides: Partial<DaemonEventAPIBody> = {},
): DaemonEventAPIBody {
  return {
    threadId: "thread-1",
    threadChatId: "chat-1",
    messages: [
      {
        type: "assistant",
        session_id: "s",
        message: { content: "hi" },
      } as never,
    ],
    timezone: "UTC",
    payloadVersion: 2,
    eventId: "event-0",
    runId: "run-1",
    seq: 0,
    ...overrides,
  };
}

async function mkTmpDir(): Promise<string> {
  return fsp.mkdtemp(join(tmpdir(), "outbox-journal-test-"));
}

describe("parseJournalBuffer", () => {
  it("skips a torn/partial final line without dropping earlier records", () => {
    const good = JSON.stringify({
      v: 1,
      t: "event",
      threadChatId: "c",
      runId: "r",
      eventId: "e0",
      seq: 0,
    });
    const raw = `${good}\n{"v":1,"t":"event","threadChatId":"c","runId":"r","eventId":"e1`;
    const records = parseJournalBuffer(raw);
    expect(records).toHaveLength(1);
    expect(records[0]!.eventId).toBe("e0");
  });

  it("skips blank lines and structurally invalid entries", () => {
    const raw = [
      "",
      "   ",
      "not json",
      JSON.stringify({ t: "event" }),
      JSON.stringify({
        v: 1,
        t: "ack",
        threadChatId: "c",
        runId: "r",
        eventId: "e0",
        seq: 0,
      }),
    ].join("\n");
    const records = parseJournalBuffer(raw);
    expect(records).toHaveLength(1);
    expect(records[0]!.t).toBe("ack");
  });
});

describe("selectUnackedEvents", () => {
  it("drops acked events and dedupes reused identity, preserving order", () => {
    const records = parseJournalBuffer(
      [
        JSON.stringify({
          v: 1,
          t: "event",
          threadChatId: "c",
          runId: "r",
          eventId: "e0",
          seq: 0,
        }),
        JSON.stringify({
          v: 1,
          t: "event",
          threadChatId: "c",
          runId: "r",
          eventId: "e0",
          seq: 0,
        }),
        JSON.stringify({
          v: 1,
          t: "ack",
          threadChatId: "c",
          runId: "r",
          eventId: "e0",
          seq: 0,
        }),
        JSON.stringify({
          v: 1,
          t: "event",
          threadChatId: "c",
          runId: "r",
          eventId: "e1",
          seq: 1,
        }),
        JSON.stringify({
          v: 1,
          t: "event",
          threadChatId: "c",
          runId: "r",
          eventId: "e2",
          seq: 2,
        }),
      ].join("\n"),
    );
    const unacked = selectUnackedEvents(records);
    expect(unacked.map((r) => r.eventId)).toEqual(["e1", "e2"]);
  });
});

describe("OutboxJournal", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkTmpDir();
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("append -> ack -> loadUnacked roundtrip drops acked, keeps unacked", async () => {
    const journal = new OutboxJournal({ dir });
    journal.recordEvent({
      threadChatId: "chat-1",
      runId: "run-1",
      eventId: "e0",
      seq: 0,
      token: "tok",
      body: makeBody({ eventId: "e0", seq: 0 }),
    });
    journal.recordEvent({
      threadChatId: "chat-1",
      runId: "run-1",
      eventId: "e1",
      seq: 1,
      token: "tok",
      body: makeBody({ eventId: "e1", seq: 1 }),
    });
    journal.recordAck({
      threadChatId: "chat-1",
      runId: "run-1",
      eventId: "e0",
      seq: 0,
    });
    await journal.flush();

    const unacked = await journal.loadUnacked();
    expect(unacked.map((r) => r.eventId)).toEqual(["e1"]);
    expect(unacked[0]!.token).toBe("tok");
    expect(unacked[0]!.body.eventId).toBe("e1");
  });

  it("preserves per-thread append order and separates threads", async () => {
    const journal = new OutboxJournal({ dir });
    for (const [chat, ids] of [
      ["chat-a", ["a0", "a1", "a2"]],
      ["chat-b", ["b0"]],
    ] as const) {
      let seq = 0;
      for (const id of ids) {
        journal.recordEvent({
          threadChatId: chat,
          runId: `run-${chat}`,
          eventId: id,
          seq: seq++,
          token: "tok",
          body: makeBody({ threadChatId: chat, eventId: id }),
        });
      }
    }
    await journal.flush();

    const unacked = await journal.loadUnacked();
    const a = unacked
      .filter((r) => r.threadChatId === "chat-a")
      .map((r) => r.eventId);
    const b = unacked
      .filter((r) => r.threadChatId === "chat-b")
      .map((r) => r.eventId);
    expect(a).toEqual(["a0", "a1", "a2"]);
    expect(b).toEqual(["b0"]);
  });

  it("compacts on ack past the size threshold, dropping acked entries", async () => {
    const journal = new OutboxJournal({ dir, compactThresholdBytes: 1 });
    journal.recordEvent({
      threadChatId: "chat-1",
      runId: "run-1",
      eventId: "e0",
      seq: 0,
      token: "tok",
      body: makeBody({ eventId: "e0" }),
    });
    journal.recordEvent({
      threadChatId: "chat-1",
      runId: "run-1",
      eventId: "e1",
      seq: 1,
      token: "tok",
      body: makeBody({ eventId: "e1", seq: 1 }),
    });
    journal.recordAck({
      threadChatId: "chat-1",
      runId: "run-1",
      eventId: "e0",
      seq: 0,
    });
    await journal.flush();

    const file = join(dir, "outbox-chat-1.jsonl");
    const raw = await fsp.readFile(file, "utf8");
    const records = parseJournalBuffer(raw);
    expect(records).toHaveLength(1);
    expect(records[0]!.t).toBe("event");
    expect(records[0]!.eventId).toBe("e1");
  });

  it("removes the file once every event is acked (via shutdown compaction)", async () => {
    const journal = new OutboxJournal({ dir });
    journal.recordEvent({
      threadChatId: "chat-1",
      runId: "run-1",
      eventId: "e0",
      seq: 0,
      token: "tok",
      body: makeBody({ eventId: "e0" }),
    });
    journal.recordAck({
      threadChatId: "chat-1",
      runId: "run-1",
      eventId: "e0",
      seq: 0,
    });
    await journal.shutdown();

    const files = await fsp.readdir(dir);
    expect(files.filter((f) => f.startsWith("outbox-"))).toHaveLength(0);
  });

  it("disabled journal writes nothing and loads nothing", async () => {
    const journal = new OutboxJournal({ dir, enabled: false });
    journal.recordEvent({
      threadChatId: "chat-1",
      runId: "run-1",
      eventId: "e0",
      seq: 0,
      token: "tok",
      body: makeBody(),
    });
    journal.recordAck({
      threadChatId: "chat-1",
      runId: "run-1",
      eventId: "e0",
      seq: 0,
    });
    await journal.flush();

    expect(await journal.loadUnacked()).toEqual([]);
    const files = await fsp.readdir(dir);
    expect(files).toHaveLength(0);
  });

  it("degrades to memory-only when journal I/O fails, never throwing", async () => {
    const filePath = join(dir, "not-a-dir");
    await fsp.writeFile(filePath, "x", "utf8");
    const badDir = join(filePath, "journal");
    const errors: unknown[] = [];
    const journal = new OutboxJournal({
      dir: badDir,
      logger: { error: (_m, d) => errors.push(d) },
    });

    expect(() =>
      journal.recordEvent({
        threadChatId: "chat-1",
        runId: "run-1",
        eventId: "e0",
        seq: 0,
        token: "tok",
        body: makeBody(),
      }),
    ).not.toThrow();
    await expect(journal.flush()).resolves.toBeUndefined();
    expect(await journal.loadUnacked()).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("daemon outbox journal replay on restart", () => {
  let runtime: DaemonRuntime;
  let dir: string;

  beforeEach(async () => {
    dir = await mkTmpDir();
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: vi.fn(() => ({
        resolvedOptions: () => ({ timeZone: "UTC" }),
      })),
    });
    runtime = new DaemonRuntime({
      url: "http://localhost:3000",
      unixSocketPath: join(dir, "daemon.sock"),
      outputFormat: "text",
    });
    vi.spyOn(runtime, "exitProcess").mockImplementation(() => {});
    vi.spyOn(runtime, "listenToUnixSocket").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    await runtime.teardown();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("re-POSTs journaled unacked events verbatim before accepting new work", async () => {
    const journal = new OutboxJournal({ dir });
    const body0 = makeBody({ eventId: "e0", seq: 0 });
    const body1 = makeBody({ eventId: "e1", seq: 1 });
    const bodyAcked = makeBody({ eventId: "e-acked", seq: 2 });
    journal.recordEvent({
      threadChatId: "chat-1",
      runId: "run-1",
      eventId: "e0",
      seq: 0,
      token: "tok-a",
      body: body0,
    });
    journal.recordEvent({
      threadChatId: "chat-1",
      runId: "run-1",
      eventId: "e1",
      seq: 1,
      token: "tok-a",
      body: body1,
    });
    journal.recordEvent({
      threadChatId: "chat-1",
      runId: "run-1",
      eventId: "e-acked",
      seq: 2,
      token: "tok-a",
      body: bodyAcked,
    });
    journal.recordAck({
      threadChatId: "chat-1",
      runId: "run-1",
      eventId: "e-acked",
      seq: 2,
    });
    await journal.flush();

    const serverPostMock = vi
      .spyOn(runtime, "serverPost")
      .mockResolvedValue(undefined);

    const replayJournal = new OutboxJournal({ dir });
    const daemon = new TerragonDaemon({
      runtime,
      outboxJournal: replayJournal,
    });
    await daemon.start();

    expect(serverPostMock).toHaveBeenCalledTimes(2);
    expect(serverPostMock.mock.calls[0]![0].eventId).toBe("e0");
    expect(serverPostMock.mock.calls[0]![1]).toBe("tok-a");
    expect(serverPostMock.mock.calls[1]![0].eventId).toBe("e1");

    await replayJournal.flush();
    expect(await replayJournal.loadUnacked()).toEqual([]);
  });
});
