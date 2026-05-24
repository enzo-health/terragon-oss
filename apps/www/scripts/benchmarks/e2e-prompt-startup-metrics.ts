export type LongTaskSample = {
  startTimeMs: number;
  durationMs: number;
  attributionNames: string[];
};

export type BenchmarkTraceSpan = {
  name?: string;
  endedAtMs?: number;
  attributes?: Record<string, unknown>;
};

export type AgUiEventToVisibleBatch = {
  oldestEventTimestampMs: number;
  newestEventTimestampMs: number;
  oldestTraceKey: string;
  traceKeys: string[];
  consumedTraceCount: number;
};

export type BrowserBenchmarkMetricHelpers = {
  summarizeLongTaskSamples: (samples: LongTaskSample[]) => {
    longTaskCount: number;
    maxLongTaskMs: number;
    totalLongTaskMs: number;
    topLongTaskEntries: LongTaskSample[];
  };
  consumeAgUiReceiptBatchForVisibleUpdate: (params: {
    spans: BenchmarkTraceSpan[];
    consumedTraceKeys: Set<string>;
    visibleEpochMs: number;
    messageIds: string[];
  }) => AgUiEventToVisibleBatch | null;
};

export function createBrowserBenchmarkMetricHelpers(): BrowserBenchmarkMetricHelpers {
  const summarizeLongTaskSamples = (samples: LongTaskSample[]) => ({
    longTaskCount: samples.length,
    maxLongTaskMs: samples.length
      ? Math.max(...samples.map((sample) => sample.durationMs))
      : 0,
    totalLongTaskMs: samples.reduce(
      (total, sample) => total + sample.durationMs,
      0,
    ),
    topLongTaskEntries: [...samples]
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 10),
  });

  const traceAttributeNumber = (
    span: BenchmarkTraceSpan,
    key: string,
  ): number | null => {
    const value = span.attributes?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  const traceAttributeString = (
    span: BenchmarkTraceSpan,
    key: string,
  ): string | null => {
    const value = span.attributes?.[key];
    return typeof value === "string" ? value : null;
  };

  const isTextReceiptSpan = (
    span: BenchmarkTraceSpan,
    messageIds: string[],
  ): boolean => {
    if (span.name !== "client.agui.event.received") {
      return false;
    }
    const messageId = traceAttributeString(span, "messageId");
    if (messageId === null || !messageIds.includes(messageId)) {
      return false;
    }
    const eventType = traceAttributeString(span, "eventType");
    return (
      eventType === "TEXT_MESSAGE_CONTENT" ||
      eventType === "REASONING_MESSAGE_CONTENT"
    );
  };

  const traceConsumptionKey = (span: BenchmarkTraceSpan): string =>
    [
      span.name ?? "",
      traceAttributeString(span, "eventType") ?? "",
      traceAttributeString(span, "messageId") ?? "",
      traceAttributeNumber(span, "eventTimestampMs") ?? "",
      span.endedAtMs ?? "",
    ].join(":");

  const consumeAgUiReceiptBatchForVisibleUpdate: BrowserBenchmarkMetricHelpers["consumeAgUiReceiptBatchForVisibleUpdate"] =
    ({ spans, consumedTraceKeys, visibleEpochMs, messageIds }) => {
      const receipts: { eventTimestampMs: number; traceKey: string }[] = [];
      for (let index = spans.length - 1; index >= 0; index--) {
        const span = spans[index];
        if (!span || !isTextReceiptSpan(span, messageIds)) {
          continue;
        }
        if (
          typeof span.endedAtMs === "number" &&
          span.endedAtMs > visibleEpochMs
        ) {
          continue;
        }
        const consumptionKey = traceConsumptionKey(span);
        if (consumedTraceKeys.has(consumptionKey)) {
          continue;
        }
        const eventTimestampMs = traceAttributeNumber(span, "eventTimestampMs");
        if (eventTimestampMs !== null && eventTimestampMs <= visibleEpochMs) {
          receipts.push({ eventTimestampMs, traceKey: consumptionKey });
        }
      }
      if (receipts.length === 0) {
        return null;
      }
      receipts.sort(
        (left, right) => left.eventTimestampMs - right.eventTimestampMs,
      );
      for (const receipt of receipts) {
        consumedTraceKeys.add(receipt.traceKey);
      }
      return {
        oldestEventTimestampMs: receipts[0]!.eventTimestampMs,
        newestEventTimestampMs: receipts[receipts.length - 1]!.eventTimestampMs,
        oldestTraceKey: receipts[0]!.traceKey,
        traceKeys: receipts.map((receipt) => receipt.traceKey),
        consumedTraceCount: receipts.length,
      };
    };

  return {
    consumeAgUiReceiptBatchForVisibleUpdate,
    summarizeLongTaskSamples,
  };
}

export const browserBenchmarkMetricHelpersSource = `(${createBrowserBenchmarkMetricHelpers.toString()})()`;
