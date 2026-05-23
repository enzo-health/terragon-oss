import { describe, expect, it } from "vitest";
import {
  consumeDaemonTraceBatchForVisibleUpdate,
  summarizeLongTaskSamples,
  type BenchmarkTraceSpan,
} from "./e2e-prompt-startup";

describe("consumeDaemonTraceBatchForVisibleUpdate", () => {
  it("consumes all unpainted content traces for one visible growth sample", () => {
    const consumedTraceKeys = new Set<string>();
    const spans: BenchmarkTraceSpan[] = [
      {
        endedAtMs: 1_005,
        attributes: {
          traceKind: "terragon.trace.daemon_event.received",
          daemonEventId: "daemon-1",
          eventId: "event-1",
          seq: 10,
          projectionIndex: 0,
          messageId: "message-1",
          agUiEventType: "TEXT_MESSAGE_CONTENT",
          daemonEventReceivedAtMs: 1_000,
        },
      },
      {
        endedAtMs: 1_055,
        attributes: {
          traceKind: "terragon.trace.daemon_event.received",
          daemonEventId: "daemon-1",
          eventId: "event-1",
          seq: 10,
          projectionIndex: 1,
          messageId: "message-1",
          agUiEventType: "TEXT_MESSAGE_CONTENT",
          daemonEventReceivedAtMs: 1_050,
        },
      },
      {
        endedAtMs: 1_015,
        attributes: {
          traceKind: "terragon.trace.daemon_event.received",
          daemonEventId: "daemon-2",
          eventId: "event-2",
          seq: 11,
          projectionIndex: 0,
          messageId: "message-2",
          agUiEventType: "TEXT_MESSAGE_CONTENT",
          daemonEventReceivedAtMs: 1_010,
        },
      },
    ];

    const batch = consumeDaemonTraceBatchForVisibleUpdate({
      spans,
      consumedTraceKeys,
      visibleEpochMs: 1_100,
      messageIds: ["message-1"],
    });

    expect(batch).toEqual({
      oldestReceivedAtMs: 1_000,
      newestReceivedAtMs: 1_050,
      oldestTraceKey: "daemon-1:event-1:10:0:message-1:TEXT_MESSAGE_CONTENT",
      traceKeys: [
        "daemon-1:event-1:10:0:message-1:TEXT_MESSAGE_CONTENT",
        "daemon-1:event-1:10:1:message-1:TEXT_MESSAGE_CONTENT",
      ],
      consumedTraceCount: 2,
    });
    expect(consumedTraceKeys).toEqual(
      new Set([
        "daemon-1:event-1:10:0:message-1:TEXT_MESSAGE_CONTENT",
        "daemon-1:event-1:10:1:message-1:TEXT_MESSAGE_CONTENT",
      ]),
    );

    const secondBatch = consumeDaemonTraceBatchForVisibleUpdate({
      spans,
      consumedTraceKeys,
      visibleEpochMs: 1_100,
      messageIds: ["message-1"],
    });

    expect(secondBatch).toBeNull();
  });

  it("does not consume traces that ended after the visible sample", () => {
    const consumedTraceKeys = new Set<string>();
    const batch = consumeDaemonTraceBatchForVisibleUpdate({
      spans: [
        {
          endedAtMs: 1_200,
          attributes: {
            traceKind: "terragon.trace.daemon_event.received",
            daemonEventId: "daemon-late",
            eventId: "event-late",
            seq: 12,
            projectionIndex: 0,
            messageId: "message-1",
            agUiEventType: "TEXT_MESSAGE_CONTENT",
            daemonEventReceivedAtMs: 1_000,
          },
        },
      ],
      consumedTraceKeys,
      visibleEpochMs: 1_100,
      messageIds: ["message-1"],
    });

    expect(batch).toBeNull();
    expect(consumedTraceKeys.size).toBe(0);
  });
});

describe("summarizeLongTaskSamples", () => {
  it("preserves scalar metrics and returns the largest diagnostics first", () => {
    const summary = summarizeLongTaskSamples([
      {
        startTimeMs: 120,
        durationMs: 51,
        attributionNames: ["small-task"],
      },
      {
        startTimeMs: 240,
        durationMs: 98,
        attributionNames: ["large-task"],
      },
      {
        startTimeMs: 360,
        durationMs: 73,
        attributionNames: [],
      },
    ]);

    expect(summary.longTaskCount).toBe(3);
    expect(summary.maxLongTaskMs).toBe(98);
    expect(summary.totalLongTaskMs).toBe(222);
    expect(summary.topLongTaskEntries[0]).toEqual({
      startTimeMs: 240,
      durationMs: 98,
      attributionNames: ["large-task"],
    });
  });
});
