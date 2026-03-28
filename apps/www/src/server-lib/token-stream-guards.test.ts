import { describe, expect, it } from "vitest";
import type { DaemonDelta } from "@terragon/daemon/shared";
import {
  buildDeltaSequenceKey,
  computeMaxSeqByKey,
  filterDeltasByKnownMaxSeq,
  normalizeDeltasForPersistence,
} from "./token-stream-guards";

function createDelta(partial: Partial<DaemonDelta>): DaemonDelta {
  return {
    messageId: partial.messageId ?? "m1",
    partIndex: partial.partIndex ?? 0,
    deltaSeq: partial.deltaSeq ?? 0,
    text: partial.text ?? "x",
    kind: partial.kind ?? "text",
  };
}

describe("token stream guards", () => {
  it("normalizes out-of-order batch deltas per message/part/kind", () => {
    const input: DaemonDelta[] = [
      createDelta({ deltaSeq: 2, text: "c" }),
      createDelta({ deltaSeq: 0, text: "a" }),
      createDelta({ deltaSeq: 1, text: "b" }),
      createDelta({ deltaSeq: 1, text: "dup" }),
    ];

    const normalized = normalizeDeltasForPersistence(input);
    expect(normalized.map((d) => `${d.deltaSeq}:${d.text}`)).toEqual([
      "0:a",
      "1:b",
      "2:c",
    ]);
  });

  it("keeps text and thinking streams isolated even when partIndex matches", () => {
    const input: DaemonDelta[] = [
      createDelta({ deltaSeq: 1, kind: "thinking", text: "t1" }),
      createDelta({ deltaSeq: 0, kind: "text", text: "x0" }),
      createDelta({ deltaSeq: 0, kind: "thinking", text: "t0" }),
      createDelta({ deltaSeq: 1, kind: "text", text: "x1" }),
    ];

    const normalized = normalizeDeltasForPersistence(input);
    const thinking = normalized.filter((d) => d.kind === "thinking");
    const text = normalized.filter((d) => d.kind !== "thinking");

    expect(thinking.map((d) => d.deltaSeq)).toEqual([0, 1]);
    expect(text.map((d) => d.deltaSeq)).toEqual([0, 1]);
  });

  it("filters stale deltas based on known max seq", () => {
    const runId = "run-1";
    const key = buildDeltaSequenceKey({
      runId,
      messageId: "m1",
      partIndex: 0,
      kind: "text",
    });
    const maxSeqByKey = new Map([[key, 4]]);

    const input = [
      createDelta({ messageId: "m1", partIndex: 0, deltaSeq: 4, text: "old" }),
      createDelta({ messageId: "m1", partIndex: 0, deltaSeq: 5, text: "new" }),
      createDelta({ messageId: "m2", partIndex: 0, deltaSeq: 0, text: "ok" }),
    ];

    const filtered = filterDeltasByKnownMaxSeq({
      deltas: input,
      runId,
      maxSeqByKey,
    });
    expect(filtered.map((d) => d.text)).toEqual(["new", "ok"]);
  });

  it("computes max seq per run/message/part/kind key", () => {
    const runId = "run-1";
    const input = [
      createDelta({ messageId: "m1", partIndex: 0, deltaSeq: 1, kind: "text" }),
      createDelta({ messageId: "m1", partIndex: 0, deltaSeq: 4, kind: "text" }),
      createDelta({
        messageId: "m1",
        partIndex: 0,
        deltaSeq: 3,
        kind: "thinking",
      }),
    ];

    const maxByKey = computeMaxSeqByKey({ deltas: input, runId });
    expect(maxByKey.size).toBe(2);
    expect(
      maxByKey.get(
        buildDeltaSequenceKey({
          runId,
          messageId: "m1",
          partIndex: 0,
          kind: "text",
        }),
      ),
    ).toBe(4);
    expect(
      maxByKey.get(
        buildDeltaSequenceKey({
          runId,
          messageId: "m1",
          partIndex: 0,
          kind: "thinking",
        }),
      ),
    ).toBe(3);
  });
});
