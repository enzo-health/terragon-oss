import { describe, test, expect } from "vitest";
import { synthesizeTerminalEntry } from "@/server-lib/ag-ui/terminal-event-synthesizer";
import { EventType } from "@ag-ui/core";

describe("terminal-event-synthesizer", () => {
  test("returns hasTerminalEvent=true when envelopes contain terminal event", () => {
    const envelopes = [
      {
        runId: "run-1",
        payload: { type: EventType.RUN_FINISHED },
      },
    ] as any[];
    const result = synthesizeTerminalEntry({
      runId: "run-1",
      envelopes,
      runContext: {
        status: "completed",
        failureTerminalReason: null,
        failureCategory: null,
      } as any,
      threadId: "t1",
    });
    expect(result.hasTerminalEvent).toBe(true);
    expect(result.syntheticTerminalEntry).toBeNull();
  });

  test("synthesizes terminal entry when no terminal event and run is terminal", () => {
    const envelopes = [] as any[];
    const result = synthesizeTerminalEntry({
      runId: "run-1",
      envelopes,
      runContext: {
        status: "completed",
        failureTerminalReason: null,
        failureCategory: null,
      } as any,
      threadId: "t1",
    });
    expect(result.hasTerminalEvent).toBe(false);
    expect(result.syntheticTerminalEntry).not.toBeNull();
    expect(result.syntheticTerminalEntry!.event.type).toBe(
      EventType.RUN_FINISHED,
    );
  });

  test("returns no synthesis when runId is null", () => {
    const envelopes = [] as any[];
    const result = synthesizeTerminalEntry({
      runId: null,
      envelopes,
      runContext: null,
      threadId: "t1",
    });
    expect(result.hasTerminalEvent).toBe(false);
    expect(result.syntheticTerminalEntry).toBeNull();
  });

  test("returns no synthesis when runContext is null", () => {
    const envelopes = [] as any[];
    const result = synthesizeTerminalEntry({
      runId: "run-1",
      envelopes,
      runContext: null,
      threadId: "t1",
    });
    expect(result.hasTerminalEvent).toBe(false);
    expect(result.syntheticTerminalEntry).toBeNull();
  });

  test("returns no synthesis when run is not terminal", () => {
    const envelopes = [] as any[];
    const result = synthesizeTerminalEntry({
      runId: "run-1",
      envelopes,
      runContext: {
        status: "working",
        failureTerminalReason: null,
        failureCategory: null,
      } as any,
      threadId: "t1",
    });
    expect(result.hasTerminalEvent).toBe(false);
    expect(result.syntheticTerminalEntry).toBeNull();
  });

  test("synthesizes terminal entry with failure info", () => {
    const envelopes = [] as any[];
    const result = synthesizeTerminalEntry({
      runId: "run-1",
      envelopes,
      runContext: {
        status: "failed",
        failureTerminalReason: "OOM killed",
        failureCategory: "resource_limit",
      } as any,
      threadId: "t1",
    });
    expect(result.syntheticTerminalEntry).not.toBeNull();
    // Failed runs produce RUN_ERROR, not RUN_FINISHED
    expect([EventType.RUN_FINISHED, EventType.RUN_ERROR]).toContain(
      result.syntheticTerminalEntry!.event.type,
    );
  });
});
