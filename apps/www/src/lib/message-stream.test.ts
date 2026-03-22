import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  appendToMessageStream,
  replayFromSeq,
  clearMessageStream,
} from "./message-stream";

vi.mock("./redis", () => {
  const streams = new Map<
    string,
    { id: string; fields: Record<string, string> }[]
  >();
  let idCounter = 0;

  return {
    redis: {
      xadd: vi.fn(
        async (key: string, _id: string, entries: Record<string, unknown>) => {
          if (!streams.has(key)) {
            streams.set(key, []);
          }
          const entryId = `${++idCounter}-0`;
          streams.get(key)!.push({
            id: entryId,
            fields: {
              seq: String(entries.seq),
              data: String(entries.data),
            },
          });
          return entryId;
        },
      ),
      xrange: vi.fn(async (key: string) => {
        const entries = streams.get(key);
        if (!entries || entries.length === 0) {
          return {};
        }
        const result: Record<string, Record<string, string>> = {};
        for (const entry of entries) {
          result[entry.id] = entry.fields;
        }
        return result;
      }),
      del: vi.fn(async (key: string) => {
        streams.delete(key);
        return 1;
      }),
      // expose for test assertions
      _streams: streams,
    },
  };
});

describe("message-stream", () => {
  beforeEach(async () => {
    const { redis } = await import("./redis");
    (redis as any)._streams.clear();
  });

  it("appends messages to stream and replays them", async () => {
    const threadId = "test-thread-1";
    const messages1 = [{ role: "assistant", content: "hello" }];
    const messages2 = [{ role: "user", content: "world" }];

    await appendToMessageStream(threadId, 1, messages1);
    await appendToMessageStream(threadId, 2, messages2);

    const replay = await replayFromSeq(threadId, 0);
    expect(replay).toHaveLength(2);
    expect(replay[0]!.seq).toBe(1);
    expect(replay[0]!.messages).toEqual(messages1);
    expect(replay[1]!.seq).toBe(2);
    expect(replay[1]!.messages).toEqual(messages2);
  });

  it("replays only messages after lastSeq", async () => {
    const threadId = "test-thread-2";
    await appendToMessageStream(threadId, 1, [{ a: 1 }]);
    await appendToMessageStream(threadId, 2, [{ a: 2 }]);
    await appendToMessageStream(threadId, 3, [{ a: 3 }]);

    const replay = await replayFromSeq(threadId, 2);
    expect(replay).toHaveLength(1);
    expect(replay[0]!.seq).toBe(3);
  });

  it("returns empty for non-existent stream", async () => {
    const replay = await replayFromSeq("nonexistent", 0);
    expect(replay).toEqual([]);
  });

  it("clears stream on delete", async () => {
    const threadId = "test-thread-3";
    await appendToMessageStream(threadId, 1, [{ x: 1 }]);

    await clearMessageStream(threadId);

    const replay = await replayFromSeq(threadId, 0);
    expect(replay).toEqual([]);
  });

  it("returns results sorted by seq", async () => {
    const threadId = "test-thread-4";
    // Append out of order (simulating concurrent writes)
    await appendToMessageStream(threadId, 3, [{ c: 3 }]);
    await appendToMessageStream(threadId, 1, [{ a: 1 }]);
    await appendToMessageStream(threadId, 2, [{ b: 2 }]);

    const replay = await replayFromSeq(threadId, 0);
    expect(replay.map((r) => r.seq)).toEqual([1, 2, 3]);
  });
});
