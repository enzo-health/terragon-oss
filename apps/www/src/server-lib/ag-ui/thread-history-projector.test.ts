import { type BaseEvent, EventType } from "@ag-ui/core";
import type { AgUiEventEnvelope } from "@terragon/shared/model/agent-event-log";
import { describe, expect, test } from "vitest";
import { deriveLatestRunIdFromEnvelopes } from "@/server-lib/ag-ui/thread-history-projector";

function envelope(params: {
  runId: string;
  seq: number;
  type: EventType;
}): AgUiEventEnvelope {
  return {
    seq: params.seq,
    runId: params.runId,
    threadChatId: "chat-1",
    payload: { type: params.type } as BaseEvent,
  };
}

describe("thread-history-projector", () => {
  test("module imports cleanly", async () => {
    const mod = await import("@/server-lib/ag-ui/thread-history-projector");
    expect(mod.projectThreadHistory).toBeDefined();
  });
});

describe("deriveLatestRunIdFromEnvelopes", () => {
  test("returns null for zero envelopes", () => {
    expect(deriveLatestRunIdFromEnvelopes([])).toBeNull();
  });

  test("returns null when no run carries a RUN_STARTED marker (legacy-shaped)", () => {
    // A run whose only rows are text/tool events but no start marker is
    // legacy-shaped and intentionally skipped, matching the SQL started_runs
    // filter. getLatestRunIdForThreadChat returns null here.
    const envelopes: AgUiEventEnvelope[] = [
      envelope({
        runId: "run-legacy",
        seq: 1,
        type: EventType.TEXT_MESSAGE_START,
      }),
      envelope({
        runId: "run-legacy",
        seq: 2,
        type: EventType.TEXT_MESSAGE_CONTENT,
      }),
      envelope({ runId: "run-legacy", seq: 3, type: EventType.RUN_FINISHED }),
    ];
    expect(deriveLatestRunIdFromEnvelopes(envelopes)).toBeNull();
  });

  test("picks the started run with the greatest max(seq)", () => {
    const envelopes: AgUiEventEnvelope[] = [
      envelope({ runId: "run-a", seq: 10, type: EventType.RUN_STARTED }),
      envelope({ runId: "run-a", seq: 11, type: EventType.RUN_FINISHED }),
      envelope({ runId: "run-b", seq: 20, type: EventType.RUN_STARTED }),
      envelope({
        runId: "run-b",
        seq: 21,
        type: EventType.TEXT_MESSAGE_CONTENT,
      }),
    ];
    expect(deriveLatestRunIdFromEnvelopes(envelopes)).toBe("run-b");
  });

  test("qualifies a run whose only row is RUN_STARTED (min==max==start)", () => {
    const envelopes: AgUiEventEnvelope[] = [
      envelope({ runId: "run-a", seq: 5, type: EventType.RUN_STARTED }),
      envelope({ runId: "run-a", seq: 6, type: EventType.RUN_FINISHED }),
      envelope({
        runId: "run-start-only",
        seq: 9,
        type: EventType.RUN_STARTED,
      }),
    ];
    expect(deriveLatestRunIdFromEnvelopes(envelopes)).toBe("run-start-only");
  });

  test("skips a later legacy run and keeps the latest started run", () => {
    // run-legacy has the highest seq but no start marker; the eligible run is
    // run-started, matching the SQL join against started_runs.
    const envelopes: AgUiEventEnvelope[] = [
      envelope({ runId: "run-started", seq: 30, type: EventType.RUN_STARTED }),
      envelope({ runId: "run-started", seq: 31, type: EventType.RUN_FINISHED }),
      envelope({
        runId: "run-legacy",
        seq: 40,
        type: EventType.TEXT_MESSAGE_CONTENT,
      }),
    ];
    expect(deriveLatestRunIdFromEnvelopes(envelopes)).toBe("run-started");
  });

  test("treats canonical run-started rows (mapped to RUN_STARTED) as markers", () => {
    // readAllAgUiEnvelopes maps canonical `run-started` rows to
    // EventType.RUN_STARTED payloads, so the in-memory filter matches the
    // SQL's `eventType IN ('RUN_STARTED','run-started')`.
    const envelopes: AgUiEventEnvelope[] = [
      envelope({
        runId: "run-canonical",
        seq: 100,
        type: EventType.RUN_STARTED,
      }),
    ];
    expect(deriveLatestRunIdFromEnvelopes(envelopes)).toBe("run-canonical");
  });
});
