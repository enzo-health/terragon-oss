import { type BaseEvent, EventType } from "@ag-ui/core";
import { describe, expect, test } from "vitest";
import {
  createRunProtocolState,
  foldRows,
  getProtocolValidationMode,
  isHardViolation,
  type PlannedRow,
  type ProtocolRow,
  RunProtocolStateStore,
  validateBatch,
} from "@/server-lib/ag-ui/run-protocol-validator";

const RUN_ID = "run-1";
const THREAD_ID = "thread-1";

function row(
  event: Partial<BaseEvent> & { type: string },
  eventId: string,
): ProtocolRow {
  return { event: event as BaseEvent, eventId };
}

function runStarted(): ProtocolRow {
  return row(
    { type: EventType.RUN_STARTED, threadId: THREAD_ID, runId: RUN_ID },
    "e-run-started",
  );
}
function runFinished(): ProtocolRow {
  return row(
    { type: EventType.RUN_FINISHED, threadId: THREAD_ID, runId: RUN_ID },
    "e-run-finished",
  );
}
function textStart(
  messageId: string,
  eventId = `start:${messageId}`,
): ProtocolRow {
  return row(
    { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
    eventId,
  );
}
function textContent(
  messageId: string,
  delta: string,
  eventId: string,
): ProtocolRow {
  return row(
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta },
    eventId,
  );
}
function textEnd(messageId: string, eventId = `end:${messageId}`): ProtocolRow {
  return row({ type: EventType.TEXT_MESSAGE_END, messageId }, eventId);
}
function reasoningContent(
  messageId: string,
  delta: string,
  eventId: string,
): ProtocolRow {
  return row(
    { type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta },
    eventId,
  );
}

function validate(rows: readonly ProtocolRow[]) {
  return validateBatch(createRunProtocolState(RUN_ID), rows);
}

function plannedEventTypes(planned: readonly PlannedRow[]): string[] {
  return planned.map((entry) =>
    entry.kind === "keep"
      ? String(entry.row.event.type)
      : String(entry.event.type),
  );
}

describe("run-protocol-validator — clean streams (no violations)", () => {
  test("a well-formed canonical turn produces zero violations and keeps every row", () => {
    const rows = [
      runStarted(),
      textStart("m1"),
      textContent("m1", "hi", "c1"),
      textEnd("m1"),
      runFinished(),
    ];
    const result = validate(rows);
    expect(result.violations).toEqual([]);
    expect(result.plannedRows).toHaveLength(rows.length);
    expect(result.plannedRows.every((entry) => entry.kind === "keep")).toBe(
      true,
    );
  });

  test("leading MESSAGES_SNAPSHOTs before RUN_STARTED are not delayed-run-started", () => {
    const rows = [
      row({ type: EventType.MESSAGES_SNAPSHOT, messages: [] }, "snap"),
      runStarted(),
      textStart("m1"),
      textContent("m1", "hi", "c1"),
      textEnd("m1"),
      runFinished(),
    ];
    expect(validate(rows).violations).toEqual([]);
  });
});

describe("run-protocol-validator — missing START before CONTENT", () => {
  test("synthesizes a TEXT_MESSAGE_START before an unopened CONTENT", () => {
    const rows = [
      runStarted(),
      textContent("m1", "hi", "c1"),
      textEnd("m1"),
      runFinished(),
    ];
    const result = validate(rows);
    expect(result.violations).toEqual([
      expect.objectContaining({
        kind: "missing_start_before_content",
        channel: "text",
        messageId: "m1",
      }),
    ]);
    expect(plannedEventTypes(result.plannedRows)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    const synthetic = result.plannedRows[1]!;
    expect(synthetic.kind).toBe("synthetic");
    if (synthetic.kind === "synthetic") {
      expect(synthetic.eventId).toBe("validator-start:run-1:m1:text");
      expect(synthetic.event).toMatchObject({
        messageId: "m1",
        role: "assistant",
      });
    }
  });

  test("synthesizes a REASONING_MESSAGE_START for unopened reasoning content", () => {
    const rows = [
      runStarted(),
      reasoningContent("r1", "think", "rc1"),
      runFinished(),
    ];
    const result = validate(rows);
    expect(result.violations[0]).toMatchObject({
      kind: "missing_start_before_content",
      channel: "reasoning",
      messageId: "r1",
    });
    // reasoning left open at terminal -> also closed by missing_end_at_terminal
    expect(result.violations.map((v) => v.kind)).toEqual([
      "missing_start_before_content",
      "missing_end_at_terminal",
    ]);
    expect(plannedEventTypes(result.plannedRows)).toEqual([
      EventType.RUN_STARTED,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });

  test("only the first CONTENT for a message synthesizes a START", () => {
    const rows = [
      runStarted(),
      textContent("m1", "a", "c1"),
      textContent("m1", "b", "c2"),
      textEnd("m1"),
      runFinished(),
    ];
    const starts = validate(rows).violations.filter(
      (v) => v.kind === "missing_start_before_content",
    );
    expect(starts).toHaveLength(1);
  });
});

describe("run-protocol-validator — orphan END", () => {
  test("drops a TEXT_MESSAGE_END with no open START", () => {
    const rows = [runStarted(), textEnd("m1"), runFinished()];
    const result = validate(rows);
    expect(result.violations).toEqual([
      expect.objectContaining({
        kind: "orphan_end",
        channel: "text",
        messageId: "m1",
      }),
    ]);
    expect(plannedEventTypes(result.plannedRows)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
  });
});

describe("run-protocol-validator — missing END at terminal", () => {
  test("synthesizes END before RUN_FINISHED for a delta-opened message", () => {
    const rows = [
      runStarted(),
      textStart("m1"),
      textContent("m1", "hi", "c1"),
      runFinished(),
    ];
    const result = validate(rows);
    expect(result.violations).toEqual([
      expect.objectContaining({
        kind: "missing_end_at_terminal",
        channel: "text",
        messageId: "m1",
      }),
    ]);
    expect(plannedEventTypes(result.plannedRows)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    const end = result.plannedRows[3]!;
    expect(end.kind).toBe("synthetic");
    if (end.kind === "synthetic") {
      expect(end.eventId).toBe("validator-end:run-1:m1:text");
    }
  });

  test("RUN_ERROR also closes open lifecycles", () => {
    const rows = [
      runStarted(),
      textStart("m1"),
      textContent("m1", "hi", "c1"),
      row({ type: EventType.RUN_ERROR, message: "boom" }, "e-run-error"),
    ];
    const kinds = validate(rows).violations.map((v) => v.kind);
    expect(kinds).toEqual(["missing_end_at_terminal"]);
  });
});

describe("run-protocol-validator — duplicate RUN_STARTED", () => {
  test("drops the second RUN_STARTED in a run", () => {
    const rows = [
      runStarted(),
      row(
        { type: EventType.RUN_STARTED, threadId: THREAD_ID, runId: RUN_ID },
        "e-run-started-2",
      ),
      textStart("m1"),
      textContent("m1", "hi", "c1"),
      textEnd("m1"),
      runFinished(),
    ];
    const result = validate(rows);
    expect(result.violations).toEqual([
      expect.objectContaining({ kind: "duplicate_run_started" }),
    ]);
    expect(
      plannedEventTypes(result.plannedRows).filter(
        (t) => t === EventType.RUN_STARTED,
      ),
    ).toHaveLength(1);
  });
});

describe("run-protocol-validator — content after terminal (hard)", () => {
  test("drops events after the terminal marker", () => {
    const rows = [
      runStarted(),
      textStart("m1"),
      textContent("m1", "hi", "c1"),
      textEnd("m1"),
      runFinished(),
      textContent("m2", "late", "late-1"),
      textStart("m2", "late-start"),
    ];
    const result = validate(rows);
    const kinds = result.violations.map((v) => v.kind);
    expect(kinds).toEqual(["content_after_terminal", "content_after_terminal"]);
    expect(result.violations.every((v) => isHardViolation(v.kind))).toBe(true);
    expect(plannedEventTypes(result.plannedRows)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });
});

describe("run-protocol-validator — delayed RUN_STARTED", () => {
  test("reorders a RUN_STARTED that arrives after run content", () => {
    const rows = [
      textContent("m1", "hi", "c1"),
      runStarted(),
      textEnd("m1"),
      runFinished(),
    ];
    const result = validate(rows);
    expect(result.violations.map((v) => v.kind)).toContain(
      "delayed_run_started",
    );
    // RUN_STARTED must be reordered to the front (ahead of the synthesized START).
    expect(plannedEventTypes(result.plannedRows)[0]).toBe(
      EventType.RUN_STARTED,
    );
  });
});

describe("run-protocol-validator — cross-batch resumability", () => {
  test("state carries an open message across batches; END in the next batch closes it", () => {
    const first = validateBatch(createRunProtocolState(RUN_ID), [
      runStarted(),
      textStart("m1"),
      textContent("m1", "a", "c1"),
    ]);
    expect(first.violations).toEqual([]);
    expect(first.state.openTextMessageIds.has("m1")).toBe(true);

    const second = validateBatch(first.state, [textEnd("m1"), runFinished()]);
    expect(second.violations).toEqual([]);
    expect(second.state.terminalSeen).toBe(true);
    expect(second.state.openTextMessageIds.has("m1")).toBe(false);
  });

  test("foldRows reconstructs equivalent state to incremental batches", () => {
    const prefix = [
      runStarted(),
      textStart("m1"),
      textContent("m1", "a", "c1"),
    ];
    const incremental = validateBatch(
      createRunProtocolState(RUN_ID),
      prefix,
    ).state;
    const folded = foldRows(RUN_ID, prefix);
    expect(folded.openTextMessageIds).toEqual(incremental.openTextMessageIds);
    expect(folded.runStartedCount).toBe(incremental.runStartedCount);
    expect(folded.terminalSeen).toBe(incremental.terminalSeen);
  });

  test("validateBatch does not mutate the passed-in prior state", () => {
    const prior = createRunProtocolState(RUN_ID);
    validateBatch(prior, [runStarted(), textStart("m1")]);
    expect(prior.runStartedCount).toBe(0);
    expect(prior.openTextMessageIds.size).toBe(0);
  });
});

describe("run-protocol-validator — enforced output is a fixpoint", () => {
  test("re-folding enforce-mode planned rows yields zero violations", () => {
    const rows = [
      runStarted(),
      textContent("m1", "hi", "c1"), // missing start
      runFinished(), // missing end at terminal
    ];
    const first = validate(rows);
    expect(first.violations.length).toBeGreaterThan(0);

    const enforcedRows: ProtocolRow[] = first.plannedRows.map((entry) =>
      entry.kind === "keep"
        ? entry.row
        : { event: entry.event, eventId: entry.eventId },
    );
    const second = validate(enforcedRows);
    expect(second.violations).toEqual([]);
  });
});

describe("run-protocol-validator — RunProtocolStateStore", () => {
  test("getOrRecover folds prior rows on a miss and caches the result", () => {
    const store = new RunProtocolStateStore();
    let recoverCalls = 0;
    const prior = [runStarted(), textStart("m1")];
    const recovered = store.getOrRecover(RUN_ID, () => {
      recoverCalls += 1;
      return prior;
    });
    expect(recovered.openTextMessageIds.has("m1")).toBe(true);
    // Second call hits the cache, no re-fold.
    store.getOrRecover(RUN_ID, () => {
      recoverCalls += 1;
      return prior;
    });
    expect(recoverCalls).toBe(1);
  });
});

describe("run-protocol-validator — mode selection", () => {
  test("defaults to observe", () => {
    expect(getProtocolValidationMode({})).toBe("observe");
  });
  test("honors off / enforce (case-insensitive, trimmed)", () => {
    expect(
      getProtocolValidationMode({ AGUI_WRITE_PROTOCOL_VALIDATION: "off" }),
    ).toBe("off");
    expect(
      getProtocolValidationMode({
        AGUI_WRITE_PROTOCOL_VALIDATION: " ENFORCE ",
      }),
    ).toBe("enforce");
  });
  test("falls back to observe on an unknown value", () => {
    expect(
      getProtocolValidationMode({ AGUI_WRITE_PROTOCOL_VALIDATION: "bogus" }),
    ).toBe("observe");
  });
});
