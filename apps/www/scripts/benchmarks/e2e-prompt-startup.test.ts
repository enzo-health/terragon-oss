import { describe, expect, it } from "vitest";
import {
  type BenchmarkTraceSpan,
  browserBenchmarkMetricHelpersSource,
  buildChecks,
  consumeAgUiReceiptBatchForVisibleUpdate,
  createBrowserBenchmarkMetricHelpers,
  summarizeLongTaskSamples,
} from "./e2e-prompt-startup";

describe("consumeAgUiReceiptBatchForVisibleUpdate", () => {
  it("consumes native AG-UI text receipts for one visible growth sample", () => {
    const consumedTraceKeys = new Set<string>();
    const spans: BenchmarkTraceSpan[] = [
      {
        name: "client.agui.event.received",
        endedAtMs: 1_010,
        attributes: {
          eventType: "TEXT_MESSAGE_CONTENT",
          messageId: "message-1",
          eventTimestampMs: 1_000,
        },
      },
      {
        name: "client.agui.event.received",
        endedAtMs: 1_060,
        attributes: {
          eventType: "TEXT_MESSAGE_CONTENT",
          messageId: "message-1",
          eventTimestampMs: 1_050,
        },
      },
      {
        name: "client.agui.event.received",
        endedAtMs: 1_020,
        attributes: {
          eventType: "TEXT_MESSAGE_CONTENT",
          messageId: "message-2",
          eventTimestampMs: 1_010,
        },
      },
    ];

    const batch = consumeAgUiReceiptBatchForVisibleUpdate({
      spans,
      consumedTraceKeys,
      visibleEpochMs: 1_100,
      messageIds: ["message-1"],
    });

    expect(batch).toEqual({
      oldestEventTimestampMs: 1_000,
      newestEventTimestampMs: 1_050,
      oldestTraceKey:
        "client.agui.event.received:TEXT_MESSAGE_CONTENT:message-1:1000:1010",
      traceKeys: [
        "client.agui.event.received:TEXT_MESSAGE_CONTENT:message-1:1000:1010",
        "client.agui.event.received:TEXT_MESSAGE_CONTENT:message-1:1050:1060",
      ],
      consumedTraceCount: 2,
    });

    const secondBatch = consumeAgUiReceiptBatchForVisibleUpdate({
      spans,
      consumedTraceKeys,
      visibleEpochMs: 1_100,
      messageIds: ["message-1"],
    });

    expect(secondBatch).toBeNull();
  });

  it("does not consume receipts received after the visible sample", () => {
    const consumedTraceKeys = new Set<string>();
    const batch = consumeAgUiReceiptBatchForVisibleUpdate({
      spans: [
        {
          name: "client.agui.event.received",
          endedAtMs: 1_200,
          attributes: {
            eventType: "TEXT_MESSAGE_CONTENT",
            messageId: "message-1",
            eventTimestampMs: 1_000,
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

describe("buildChecks", () => {
  const passingMetrics = {
    promptSubmittedAtMs: 0,
    threadCreatedMs: 100,
    sandboxReadyMs: null,
    daemonConnectedMs: null,
    firstDaemonEventMs: null,
    firstAssistantTextMs: 200,
    firstToolStartMs: null,
    firstToolOutputMs: null,
    completionMs: 300,
    totalRunMs: 400,
    daemonEventCount: 1,
    assistantTextChunkCount: 1,
    streamedTextBytes: 10,
    interChunkGapP50Ms: 10,
    interChunkGapP95Ms: 10,
    maxSilentGapMs: 10,
    chunksPerSecond: 2,
    routeErrorCount: 0,
    reconnectCount: 0,
    scopedAssistantTextChunkCount: 2,
    scopedStreamedTextBytes: 10,
    scopedInterChunkGapP50Ms: 10,
    scopedInterChunkGapP95Ms: 10,
    scopedMaxSilentGapMs: 10,
    visibleUpdateCount: 2,
    activeStreamGapCount: 1,
    activeStreamGapP95Ms: 10,
    agUiEventToVisibleUpdateMsP95: 100,
    longTaskCount: 0,
    maxLongTaskMs: 0,
    totalLongTaskMs: 0,
    rafFrameGapP95Ms: 16,
    cumulativeLayoutShift: 0,
  };
  const thresholds = {
    threadCreatedMs: 1_000,
    firstAssistantTextMs: 1_000,
    completionMs: 1_000,
    totalRunMs: 1_000,
    maxSilentGapMs: 1_000,
    scopedMaxSilentGapMs: 1_000,
    activeStreamGapMs: 250,
    agUiEventToVisibleUpdateMs: 250,
    minAssistantTextChunks: 1,
    minVisibleUpdates: 1,
    maxLongTaskMs: 100,
    totalLongTaskMs: 300,
    rafFrameGapP95Ms: 80,
    cumulativeLayoutShift: 0.02,
    routeErrorCount: 0,
  };

  it("fails when the native AG-UI event-to-visible metric is missing", () => {
    const checks = buildChecks(
      { ...passingMetrics, agUiEventToVisibleUpdateMsP95: null },
      thresholds,
    );

    expect(
      checks.find(
        (check) => check.name === "ag-ui-event-to-visible-update-budget",
      ),
    ).toMatchObject({ status: "fail", actual: "missing", limit: 250 });
  });

  it("fails when the native AG-UI event-to-visible metric exceeds budget", () => {
    const checks = buildChecks(
      { ...passingMetrics, agUiEventToVisibleUpdateMsP95: 251 },
      thresholds,
    );

    expect(
      checks.find(
        (check) => check.name === "ag-ui-event-to-visible-update-budget",
      ),
    ).toMatchObject({ status: "fail", actual: 251, limit: 250 });
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

describe("browserBenchmarkMetricHelpersSource", () => {
  it("serializes the shared helpers for injected browser code", () => {
    const helpers = createBrowserBenchmarkMetricHelpers();

    expect(browserBenchmarkMetricHelpersSource).toContain(
      "consumeAgUiReceiptBatchForVisibleUpdate",
    );
    expect(
      helpers.consumeAgUiReceiptBatchForVisibleUpdate({
        spans: [],
        consumedTraceKeys: new Set<string>(),
        visibleEpochMs: 1,
        messageIds: ["message-1"],
      }),
    ).toBeNull();
    expect(helpers.summarizeLongTaskSamples([]).maxLongTaskMs).toBe(0);
  });
});
