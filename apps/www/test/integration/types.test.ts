import { describe, expect, it } from "vitest";
import type { RecordedDaemonEvent } from "./types";

// A minimal hand-written JSONL sample: three events in order.
const SAMPLE_JSONL = `\
{"wallClockMs":0,"body":{"threadId":"thread-001","threadChatId":"chat-001","messages":[{"type":"system","subtype":"init","session_id":"sess-1","tools":["bash"],"mcp_servers":[]}],"timezone":"UTC"},"headers":{"content-type":"application/json"}}
{"wallClockMs":120,"body":{"threadId":"thread-001","threadChatId":"chat-001","messages":[{"type":"assistant","session_id":"sess-1","parent_tool_use_id":null,"message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}],"timezone":"UTC"},"headers":{"content-type":"application/json"}}
{"wallClockMs":350,"body":{"threadId":"thread-001","threadChatId":"chat-001","messages":[{"type":"custom-stop","session_id":null,"duration_ms":350}],"timezone":"UTC"},"headers":{"content-type":"application/json"}}`;

function parseJsonl(raw: string): RecordedDaemonEvent[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedDaemonEvent);
}

describe("RecordedDaemonEvent JSONL parsing", () => {
  it("parses all three lines from the sample", () => {
    const events = parseJsonl(SAMPLE_JSONL);
    expect(events).toHaveLength(3);
  });

  it("wallClockMs values are in ascending order", () => {
    const events = parseJsonl(SAMPLE_JSONL);
    const timestamps = events.map((e) => e.wallClockMs);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]!);
    }
  });

  it("extracts threadId from each body", () => {
    const events = parseJsonl(SAMPLE_JSONL);
    for (const event of events) {
      expect(event.body.threadId).toBe("thread-001");
    }
  });

  it("extracts threadChatId from each body", () => {
    const events = parseJsonl(SAMPLE_JSONL);
    for (const event of events) {
      expect(event.body.threadChatId).toBe("chat-001");
    }
  });

  it("first event has system/init message type", () => {
    const events = parseJsonl(SAMPLE_JSONL);
    const firstMsg = events[0]?.body.messages[0];
    expect(firstMsg?.type).toBe("system");
  });

  it("last event has custom-stop message type", () => {
    const events = parseJsonl(SAMPLE_JSONL);
    const lastMsg = events[events.length - 1]?.body.messages[0];
    expect(lastMsg?.type).toBe("custom-stop");
  });

  it("preserves headers", () => {
    const events = parseJsonl(SAMPLE_JSONL);
    for (const event of events) {
      expect(event.headers["content-type"]).toBe("application/json");
    }
  });

  it("first event wallClockMs is 0", () => {
    const events = parseJsonl(SAMPLE_JSONL);
    expect(events[0]?.wallClockMs).toBe(0);
  });
});
