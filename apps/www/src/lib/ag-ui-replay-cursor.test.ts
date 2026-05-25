import { describe, expect, it } from "vitest";
import {
  classifyAgUiPostIntent,
  parseAgUiReplayCursor,
  replayQueryAfterSeq,
  resolveAgUiReplayCursor,
  serializeAgUiReplayCursor,
  shouldReplayEnvelope,
} from "./ag-ui-replay-cursor";

describe("AG-UI replay cursor", () => {
  it("parses bare seq and seq-prefixed cursors", () => {
    expect(parseAgUiReplayCursor("42")).toEqual({
      seq: 42,
      projectionIndex: null,
    });
    expect(parseAgUiReplayCursor("seq:42")).toEqual({
      seq: 42,
      projectionIndex: null,
    });
  });

  it("parses projection cursors", () => {
    expect(parseAgUiReplayCursor("42:3")).toEqual({
      seq: 42,
      projectionIndex: 3,
    });
  });

  it("rejects malformed cursors", () => {
    expect(parseAgUiReplayCursor(null)).toBeNull();
    expect(parseAgUiReplayCursor("")).toBeNull();
    expect(parseAgUiReplayCursor("-2")).toBeNull();
    expect(parseAgUiReplayCursor("nope")).toBeNull();
    expect(parseAgUiReplayCursor("1:-1")).toBeNull();
  });

  it("serializes cursors", () => {
    expect(serializeAgUiReplayCursor({ seq: 42, projectionIndex: null })).toBe(
      "42",
    );
    expect(serializeAgUiReplayCursor({ seq: 42, projectionIndex: 3 })).toBe(
      "42:3",
    );
  });

  it("prefers Last-Event-ID over fromSeq", () => {
    expect(resolveAgUiReplayCursor({ lastEventId: "9", fromSeq: "4" })).toEqual(
      {
        seq: 9,
        projectionIndex: null,
      },
    );
  });

  it("calculates replay query lower bounds", () => {
    expect(replayQueryAfterSeq(null)).toBeUndefined();
    expect(replayQueryAfterSeq({ seq: 9, projectionIndex: null })).toBe(9);
    expect(replayQueryAfterSeq({ seq: 9, projectionIndex: 2 })).toBe(8);
  });

  it("filters projected envelopes after the cursor", () => {
    const cursor = { seq: 9, projectionIndex: 1 };

    expect(shouldReplayEnvelope({ seq: 8 }, cursor)).toBe(false);
    expect(shouldReplayEnvelope({ seq: 9, projectionIndex: 1 }, cursor)).toBe(
      false,
    );
    expect(shouldReplayEnvelope({ seq: 9, projectionIndex: 2 }, cursor)).toBe(
      true,
    );
    expect(shouldReplayEnvelope({ seq: 10 }, cursor)).toBe(true);
  });

  it("lets explicit append intent win over a stale cursor", () => {
    const body = {
      forwardedProps: {
        runConfig: { terragon: { intent: "append" } },
      },
    };

    expect(
      classifyAgUiPostIntent({ lastEventId: null, fromSeq: "42", body }),
    ).toBe("append");
    expect(
      classifyAgUiPostIntent({ lastEventId: "42", fromSeq: null, body }),
    ).toBe("append");
  });

  it("classifies cursor-only POSTs as resume", () => {
    const body = { forwardedProps: {} };

    expect(
      classifyAgUiPostIntent({ lastEventId: null, fromSeq: "42", body }),
    ).toBe("resume");
  });

  it("falls back to typed forwarded intent when no cursor is present", () => {
    expect(
      classifyAgUiPostIntent({
        lastEventId: null,
        fromSeq: null,
        body: {
          forwardedProps: {
            runConfig: { terragon: { intent: "resume" } },
          },
        },
      }),
    ).toBe("resume");
  });
});
