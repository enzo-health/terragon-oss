import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetUnknownEventTelemetry,
  getRecentUnknownEvents,
  getUnknownEventCounters,
  recordUnknownEvent,
} from "./unknown-event-telemetry";

describe("unknown-event-telemetry", () => {
  afterEach(() => {
    __resetUnknownEventTelemetry();
  });

  it("increments counters keyed by transport + method + itemType", () => {
    recordUnknownEvent({
      transport: "codex",
      method: "item",
      itemType: "imageView",
    });
    recordUnknownEvent({
      transport: "codex",
      method: "item",
      itemType: "imageView",
    });
    recordUnknownEvent({
      transport: "codex",
      method: "item",
      itemType: "enteredReviewMode",
    });

    const counters = getUnknownEventCounters();
    expect(counters["codex:item:imageView"]).toBe(2);
    expect(counters["codex:item:enteredReviewMode"]).toBe(1);
  });

  it("distinguishes transports that share method names", () => {
    recordUnknownEvent({
      transport: "codex",
      method: "session/update",
    });
    recordUnknownEvent({
      transport: "acp",
      method: "session/update",
      itemType: "config_option_update",
    });

    const counters = getUnknownEventCounters();
    expect(counters["codex:session/update"]).toBe(1);
    expect(counters["acp:session/update:config_option_update"]).toBe(1);
  });

  it("stores a bounded ring buffer of recent events", () => {
    for (let i = 0; i < 10; i++) {
      recordUnknownEvent({
        transport: "codex",
        method: `m/${i}`,
        payload: { i },
      });
    }

    const recent = getRecentUnknownEvents();
    expect(recent).toHaveLength(10);
    expect(recent[0]?.method).toBe("m/0");
    expect(recent[9]?.method).toBe("m/9");
    expect(recent[0]?.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it("caps ring buffer at 500 entries (drops oldest)", () => {
    for (let i = 0; i < 600; i++) {
      recordUnknownEvent({ transport: "codex", method: `m/${i}` });
    }
    const recent = getRecentUnknownEvents(1000);
    expect(recent).toHaveLength(500);
    expect(recent[0]?.method).toBe("m/100");
    expect(recent[499]?.method).toBe("m/599");
  });

  it("truncates large payloads to protect memory", () => {
    const huge = "x".repeat(5000);
    recordUnknownEvent({
      transport: "codex",
      method: "m",
      payload: { huge },
    });
    const [entry] = getRecentUnknownEvents();
    const payload = entry?.payload as {
      __truncated?: boolean;
      originalLength?: number;
    };
    expect(payload?.__truncated).toBe(true);
    expect(payload?.originalLength).toBeGreaterThan(5000);
  });

  it("handles unserializable payloads without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      recordUnknownEvent({
        transport: "codex",
        method: "m",
        payload: circular,
      }),
    ).not.toThrow();
    const [entry] = getRecentUnknownEvents();
    expect(
      (entry?.payload as { __unserializable?: boolean })?.__unserializable,
    ).toBe(true);
  });

  it("writes a rate-limited stderr warn on first occurrence of a key", () => {
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      recordUnknownEvent({
        transport: "codex",
        method: "m",
        itemType: "x",
      });
      recordUnknownEvent({
        transport: "codex",
        method: "m",
        itemType: "x",
      });
      const calls = writeSpy.mock.calls.filter((c) =>
        String(c[0]).includes("[unknown-event] codex:m:x"),
      );
      // First occurrence logs; second is suppressed by the 60s rate limit.
      expect(calls).toHaveLength(1);
      expect(String(calls[0]?.[0])).toContain("count=1");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("never throws even if something goes wrong internally", () => {
    // Pass an object whose toString throws when serialized — belt-and-suspenders.
    const bad = {
      get self() {
        throw new Error("boom");
      },
    };
    expect(() =>
      recordUnknownEvent({
        transport: "codex",
        method: "m",
        payload: bad,
      }),
    ).not.toThrow();
  });
});
