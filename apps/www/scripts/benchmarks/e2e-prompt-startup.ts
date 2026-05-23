#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

type Status = "pass" | "fail";

type Thresholds = {
  threadCreatedMs: number;
  firstAssistantTextMs: number;
  completionMs: number;
  totalRunMs: number;
  maxSilentGapMs: number;
  scopedMaxSilentGapMs: number;
  activeStreamGapMs: number;
  daemonEventToVisibleUpdateMs: number;
  minAssistantTextChunks: number;
  minVisibleUpdates: number;
  maxLongTaskMs: number;
  totalLongTaskMs: number;
  rafFrameGapP95Ms: number;
  cumulativeLayoutShift: number;
  routeErrorCount: number;
};

type Config = {
  appUrl: string;
  repo: string;
  branch: string;
  prompt: string;
  promptName: string;
  iterations: number;
  warmup: number;
  timeoutMs: number;
  out: string;
  eventsOut: string | null;
  screenshotDir: string | null;
  failOnThreshold: boolean;
  headless: boolean;
  thresholds: Thresholds;
};

type Check = {
  name: string;
  status: Status;
  actual: number | boolean | string;
  limit?: number;
  expected?: number | boolean | string;
};

type RunMetrics = {
  promptSubmittedAtMs: number;
  threadCreatedMs: number | null;
  sandboxReadyMs: number | null;
  daemonConnectedMs: number | null;
  firstDaemonEventMs: number | null;
  firstAssistantTextMs: number | null;
  firstToolStartMs: number | null;
  firstToolOutputMs: number | null;
  completionMs: number | null;
  totalRunMs: number;
  daemonEventCount: number;
  assistantTextChunkCount: number;
  streamedTextBytes: number;
  interChunkGapP50Ms: number | null;
  interChunkGapP95Ms: number | null;
  maxSilentGapMs: number | null;
  chunksPerSecond: number | null;
  routeErrorCount: number;
  reconnectCount: number;
  scopedAssistantTextChunkCount: number;
  scopedStreamedTextBytes: number;
  scopedInterChunkGapP50Ms: number | null;
  scopedInterChunkGapP95Ms: number | null;
  scopedMaxSilentGapMs: number | null;
  visibleUpdateCount: number;
  activeStreamGapCount: number;
  activeStreamGapP95Ms: number | null;
  daemonEventToVisibleUpdateMsP95: number | null;
  longTaskCount: number;
  maxLongTaskMs: number;
  totalLongTaskMs: number;
  rafFrameGapP95Ms: number | null;
  cumulativeLayoutShift: number;
};

type RunResult = {
  iteration: number;
  warmup: boolean;
  status: Status;
  taskUrl: string | null;
  metrics: RunMetrics;
  checks: Check[];
  errors: string[];
  screenshots: Record<string, string>;
  diagnostics?: BrowserStreamMetricDiagnostics;
};

type DaemonEventToVisibleSample = {
  messageId: string;
  visibleAtMs: number;
  visibleEpochMs: number;
  daemonReceivedAtMs: number;
  newestDaemonReceivedAtMs: number;
  daemonEventToVisibleUpdateMs: number;
  newestDaemonEventToVisibleUpdateMs: number;
  traceKey: string;
  traceKeys: string[];
  consumedTraceCount: number;
  textLength: number;
  textDeltaBytes: number;
};

type VisibleUpdateSample = {
  messageId: string;
  sourceIds: string[];
  visibleAtMs: number;
  visibleEpochMs: number;
  textLength: number;
  textDeltaBytes: number;
  gapMs: number | null;
  uiOwnedGapMs: number | null;
  daemonReceivedAtMs: number | null;
};

type TextTraceSpanSample = {
  traceKey: string;
  messageId: string | null;
  agUiEventType: string | null;
  receivedAtMs: number | null;
  endedAtMs: number | null;
  consumed: boolean;
};

type LayoutShiftSample = {
  startTime: number;
  value: number;
  sources: string[];
};

type BrowserStreamMetricDiagnostics = {
  daemonEventToVisibleSamples: DaemonEventToVisibleSample[];
  visibleUpdates: VisibleUpdateSample[];
  textTraceSpans: TextTraceSpanSample[];
  layoutShiftEntries: LayoutShiftSample[];
};

export type BenchmarkTraceSpan = {
  name?: string;
  endedAtMs?: number;
  attributes?: Record<string, unknown>;
};

export type BenchmarkDaemonTraceBatch = {
  oldestReceivedAtMs: number;
  newestReceivedAtMs: number;
  oldestTraceKey: string;
  traceKeys: string[];
  consumedTraceCount: number;
};

export function consumeDaemonTraceBatchForVisibleUpdate({
  spans,
  consumedTraceKeys,
  visibleEpochMs,
  messageIds,
}: {
  spans: BenchmarkTraceSpan[];
  consumedTraceKeys: Set<string>;
  visibleEpochMs: number;
  messageIds: string[];
}): BenchmarkDaemonTraceBatch | null {
  const traceAttributeNumber = (
    span: BenchmarkTraceSpan,
    key: string,
  ): number | null => {
    const value = span.attributes?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  const isVisibleTextTraceSpan = (span: BenchmarkTraceSpan): boolean => {
    if (
      span.attributes?.["traceKind"] !== "terragon.trace.daemon_event.received"
    ) {
      return false;
    }
    if (!messageIds.includes(String(span.attributes["messageId"]))) {
      return false;
    }
    return (
      span.attributes["agUiEventType"] === "TEXT_MESSAGE_CONTENT" ||
      span.attributes["agUiEventType"] === "REASONING_MESSAGE_CONTENT"
    );
  };

  const traceConsumptionKey = (span: BenchmarkTraceSpan): string =>
    [
      span.attributes?.["daemonEventId"] ?? "",
      span.attributes?.["eventId"] ?? "",
      span.attributes?.["seq"] ?? "",
      span.attributes?.["projectionIndex"] ?? "",
      span.attributes?.["messageId"] ?? "",
      span.attributes?.["agUiEventType"] ?? "",
    ].join(":");

  const traceReceivedAtMs = (span: BenchmarkTraceSpan): number | null => {
    const direct =
      traceAttributeNumber(span, "daemonEventReceivedAtMs") ??
      traceAttributeNumber(span, "daemonReceivedAtMs") ??
      traceAttributeNumber(span, "serverDaemonEventReceivedAtMs");
    if (direct !== null) {
      return direct;
    }
    if (
      span.name === "server.daemon_event.received" &&
      typeof span.endedAtMs === "number"
    ) {
      return span.endedAtMs;
    }
    return null;
  };

  const traces: { receivedAtMs: number; traceKey: string }[] = [];
  for (let index = spans.length - 1; index >= 0; index--) {
    const span = spans[index];
    if (!span || !isVisibleTextTraceSpan(span)) {
      continue;
    }
    if (typeof span.endedAtMs === "number" && span.endedAtMs > visibleEpochMs) {
      continue;
    }
    const consumptionKey = traceConsumptionKey(span);
    if (consumedTraceKeys.has(consumptionKey)) {
      continue;
    }
    const receivedAtMs = traceReceivedAtMs(span);
    if (receivedAtMs !== null && receivedAtMs <= visibleEpochMs) {
      traces.push({ receivedAtMs, traceKey: consumptionKey });
    }
  }
  if (traces.length === 0) {
    return null;
  }
  traces.sort((left, right) => left.receivedAtMs - right.receivedAtMs);
  for (const trace of traces) {
    consumedTraceKeys.add(trace.traceKey);
  }
  return {
    oldestReceivedAtMs: traces[0]!.receivedAtMs,
    newestReceivedAtMs: traces[traces.length - 1]!.receivedAtMs,
    oldestTraceKey: traces[0]!.traceKey,
    traceKeys: traces.map((trace) => trace.traceKey),
    consumedTraceCount: traces.length,
  };
}

type BrowserStreamMetricSnapshot = {
  assistantTextChunkCount: number;
  streamedTextBytes: number;
  interChunkGapP50Ms: number | null;
  interChunkGapP95Ms: number | null;
  maxSilentGapMs: number | null;
  visibleUpdateCount: number;
  activeStreamGapCount: number;
  activeStreamGapP95Ms: number | null;
  daemonEventToVisibleUpdateMsP95: number | null;
  longTaskCount: number;
  maxLongTaskMs: number;
  totalLongTaskMs: number;
  rafFrameGapP95Ms: number | null;
  cumulativeLayoutShift: number;
  diagnostics: BrowserStreamMetricDiagnostics;
};

type BenchmarkReport = {
  schemaVersion: 1;
  kind: "e2e-prompt-startup-streaming-benchmark";
  generatedAt: string;
  git: {
    sha: string;
    branch: string;
    dirty: boolean;
  };
  target: {
    appUrl: string;
    sandboxProvider: string | null;
    transportMode: string;
    promptName: string;
    repo: string;
    branch: string;
  };
  config: {
    iterations: number;
    warmup: number;
    timeoutMs: number;
    thresholds: Thresholds;
  };
  summary: {
    status: Status;
    metrics: Record<string, number | null>;
    checks: Check[];
  };
  runs: RunResult[];
};

const DEFAULT_PROMPT =
  "Benchmark prompt: print the current working directory, then echo terragon-e2e-benchmark-visible, then stop. Do not edit files, commit, push, or open a PR.";

const DEFAULT_THRESHOLDS: Thresholds = {
  threadCreatedMs: 30_000,
  firstAssistantTextMs: 300_000,
  completionMs: 600_000,
  totalRunMs: 600_000,
  maxSilentGapMs: 45_000,
  scopedMaxSilentGapMs: 1_500,
  activeStreamGapMs: 750,
  daemonEventToVisibleUpdateMs: 250,
  minAssistantTextChunks: 1,
  minVisibleUpdates: 2,
  maxLongTaskMs: 100,
  totalLongTaskMs: 300,
  rafFrameGapP95Ms: 80,
  cumulativeLayoutShift: 0.02,
  routeErrorCount: 0,
};

const SUBMIT_STARTED_AT_STORAGE_KEY = "__terragonPromptSubmittedAtEpochMs";

function parseArgs(argv: string[]): Config {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, true);
    } else {
      args.set(key, next);
      i++;
    }
  }

  const promptFile = stringArg(args, "prompt-file", "");
  const prompt =
    stringArg(args, "prompt", "") ||
    (promptFile ? fs.readFileSync(promptFile, "utf8").trim() : "") ||
    DEFAULT_PROMPT;
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...jsonArg<Partial<Thresholds>>(args, "thresholds", {}),
  };

  return {
    appUrl: stringArg(args, "app-url", "http://localhost:3000").replace(
      /\/$/,
      "",
    ),
    repo: stringArg(args, "repo", "enzo-health/terragon-oss"),
    branch: stringArg(args, "branch", "main"),
    prompt,
    promptName: stringArg(args, "prompt-name", "minimal-streaming-smoke"),
    iterations: numberArg(args, "iterations", 1),
    warmup: numberArg(args, "warmup", 0),
    timeoutMs: numberArg(args, "timeout-ms", 600_000),
    out: stringArg(
      args,
      "out",
      path.resolve(process.cwd(), ".codex-artifacts/e2e-prompt-benchmark.json"),
    ),
    eventsOut: nullableStringArg(args, "events-out"),
    screenshotDir: nullableStringArg(args, "screenshot-dir"),
    failOnThreshold: booleanArg(args, "fail-on-threshold", false),
    headless: !booleanArg(args, "headed", false),
    thresholds,
  };
}

function shouldPrintHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

function printHelp(): void {
  console.log(`Terragon E2E prompt startup benchmark

Usage:
  pnpm -C apps/www benchmark:e2e-prompt -- [options]

Options:
  --app-url <url>             Running app URL. Default: http://localhost:3000
  --repo <owner/name>         Repository to select. Default: enzo-health/terragon-oss
  --branch <name>             Branch to select. Default: main
  --prompt <text>             Prompt text to submit
  --prompt-file <path>        Read prompt text from a file
  --prompt-name <name>        Label stored in the JSON report
  --iterations <n>            Measured runs. Default: 1
  --warmup <n>                Warmup runs excluded from summary. Default: 0
  --timeout-ms <n>            Per-run timeout. Default: 600000
  --out <path>                JSON report path
  --events-out <path>         Optional JSONL run-events path
  --screenshot-dir <path>     Optional screenshot artifact directory
  --thresholds <json>         Partial threshold override JSON
  --fail-on-threshold         Exit non-zero when summary checks fail
  --headed                    Run Chromium headed
  --help                      Show this help
`);
}

function stringArg(
  args: Map<string, string | true>,
  key: string,
  fallback: string,
): string {
  const value = args.get(key);
  return typeof value === "string" ? value : fallback;
}

function nullableStringArg(
  args: Map<string, string | true>,
  key: string,
): string | null {
  const value = args.get(key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberArg(
  args: Map<string, string | true>,
  key: string,
  fallback: number,
): number {
  const value = args.get(key);
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanArg(
  args: Map<string, string | true>,
  key: string,
  fallback: boolean,
): boolean {
  const value = args.get(key);
  if (value === true) return true;
  if (typeof value !== "string") return fallback;
  return value === "true" || value === "1";
}

function jsonArg<T>(
  args: Map<string, string | true>,
  key: string,
  fallback: T,
): T {
  const value = args.get(key);
  if (typeof value !== "string") return fallback;
  return JSON.parse(value) as T;
}

function nowMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

async function installBrowserStreamMetrics(page: Page): Promise<void> {
  const script = `(() => {
    const submitStartedAtStorageKey = ${JSON.stringify(
      SUBMIT_STARTED_AT_STORAGE_KEY,
    )};
    const metricWindow = window;
    if (metricWindow.__terragonStreamMetrics) {
      metricWindow.__terragonStreamMetrics.dispose();
    }

    const state = {
      startedAtEpochMs: null,
      previousAgentTextByMessageId: {},
      chunkTimes: [],
      visibleUpdates: [],
      activeStreamGaps: [],
      daemonEventToVisibleUpdateSamples: [],
      daemonEventToVisibleSamples: [],
      consumedDaemonTraceKeys: new Set(),
      agentTraceSpans: [],
      streamedTextBytes: 0,
      longTasks: [],
      rafFrameGaps: [],
      layoutShiftEntries: [],
      layoutShiftResetAtMs: 0,
      lastRafAt: null,
      observer: null,
      longTaskObserver: null,
      layoutShiftObserver: null,
      rafId: null,
      pendingTextMutationRafId: null,
    };

    const storedStartedAtEpochMs = window.sessionStorage.getItem(
      submitStartedAtStorageKey,
    );
    if (storedStartedAtEpochMs !== null) {
      const parsed = Number(storedStartedAtEpochMs);
      state.startedAtEpochMs = Number.isFinite(parsed) ? parsed : null;
    }

    const relativeNow = () =>
      state.startedAtEpochMs === null
        ? null
        : performance.timeOrigin + performance.now() - state.startedAtEpochMs;
    const epochNow = () => performance.timeOrigin + performance.now();

    const sorted = (values) =>
      Array.from(values).sort((left, right) => left - right);

    const pickPercentile = (values, p) => {
      if (values.length === 0) return null;
      const sortedValues = sorted(values);
      const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1),
      );
      return sortedValues[index] ?? null;
    };

    const lastAgentMessage = () => {
      const rows = document.querySelectorAll('[data-message-role="agent"]');
      const last = rows.item(rows.length - 1);
      return last
        ? {
            id:
              last.getAttribute("data-message-id") ??
              String(rows.length - 1),
            sourceIds: (
              last.getAttribute("data-message-source-ids") ?? ""
            )
              .split(/\\s+/)
              .filter(Boolean),
            text: last.textContent ?? "",
          }
        : null;
    };

    const consumeDaemonTraceBatchForVisibleUpdate = ({
      spans,
      consumedTraceKeys,
      visibleEpochMs,
      messageIds,
    }) => {
      const traceAttributeNumber = (span, key) => {
        const value = span?.attributes?.[key];
        return typeof value === "number" && Number.isFinite(value)
          ? value
          : null;
      };
      const isVisibleTextTraceSpan = (span) => {
        if (span?.attributes?.traceKind !== "terragon.trace.daemon_event.received") {
          return false;
        }
        if (!messageIds.includes(String(span.attributes.messageId))) {
          return false;
        }
        return (
          span.attributes.agUiEventType === "TEXT_MESSAGE_CONTENT" ||
          span.attributes.agUiEventType === "REASONING_MESSAGE_CONTENT"
        );
      };
      const traceConsumptionKey = (span) =>
        [
          span?.attributes?.daemonEventId ?? "",
          span?.attributes?.eventId ?? "",
          span?.attributes?.seq ?? "",
          span?.attributes?.projectionIndex ?? "",
          span?.attributes?.messageId ?? "",
          span?.attributes?.agUiEventType ?? "",
        ].join(":");
      const traceReceivedAtMs = (span) => {
        const direct =
          traceAttributeNumber(span, "daemonEventReceivedAtMs") ??
          traceAttributeNumber(span, "daemonReceivedAtMs") ??
          traceAttributeNumber(span, "serverDaemonEventReceivedAtMs");
        if (direct !== null) {
          return direct;
        }
        if (
          span?.name === "server.daemon_event.received" &&
          typeof span.endedAtMs === "number"
        ) {
          return span.endedAtMs;
        }
        return null;
      };
      const traces = [];
      for (let index = spans.length - 1; index >= 0; index--) {
        const span = spans[index];
        if (!span || !isVisibleTextTraceSpan(span)) {
          continue;
        }
        if (typeof span.endedAtMs === "number" && span.endedAtMs > visibleEpochMs) {
          continue;
        }
        const consumptionKey = traceConsumptionKey(span);
        if (consumedTraceKeys.has(consumptionKey)) {
          continue;
        }
        const receivedAtMs = traceReceivedAtMs(span);
        if (receivedAtMs !== null && receivedAtMs <= visibleEpochMs) {
          traces.push({ receivedAtMs, traceKey: consumptionKey });
        }
      }
      if (traces.length === 0) {
        return null;
      }
      traces.sort((left, right) => left.receivedAtMs - right.receivedAtMs);
      for (const trace of traces) {
        consumedTraceKeys.add(trace.traceKey);
      }
      return {
        oldestReceivedAtMs: traces[0].receivedAtMs,
        newestReceivedAtMs: traces[traces.length - 1].receivedAtMs,
        oldestTraceKey: traces[0].traceKey,
        traceKeys: traces.map((trace) => trace.traceKey),
        consumedTraceCount: traces.length,
      };
    };

    const traceAttributeNumber = (span, key) => {
      const value = span?.attributes?.[key];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    };

    const traceConsumptionKey = (span) =>
      [
        span?.attributes?.daemonEventId ?? "",
        span?.attributes?.eventId ?? "",
        span?.attributes?.seq ?? "",
        span?.attributes?.projectionIndex ?? "",
        span?.attributes?.messageId ?? "",
        span?.attributes?.agUiEventType ?? "",
      ].join(":");

    const isTextTraceSpan = (span) =>
      span?.attributes?.traceKind === "terragon.trace.daemon_event.received" &&
      (span.attributes.agUiEventType === "TEXT_MESSAGE_CONTENT" ||
        span.attributes.agUiEventType === "REASONING_MESSAGE_CONTENT");

    const traceReceivedAtMs = (span) =>
      traceAttributeNumber(span, "daemonEventReceivedAtMs") ??
      traceAttributeNumber(span, "daemonReceivedAtMs") ??
      traceAttributeNumber(span, "serverDaemonEventReceivedAtMs") ??
      (span?.name === "server.daemon_event.received" &&
      typeof span.endedAtMs === "number"
        ? span.endedAtMs
        : null);

    const recordBenchmarkTraceSpan = (name, attributes) => {
      const endedAtMs = epochNow();
      const traceId =
        state.agentTraceSpans[state.agentTraceSpans.length - 1]?.traceId ??
        "browser-benchmark";
      const span = {
        schemaVersion: 1,
        traceId,
        spanId:
          name +
          ":" +
          Math.round(endedAtMs) +
          ":" +
          Math.random().toString(36).slice(2),
        name,
        startedAtMs: endedAtMs,
        endedAtMs,
        durationMs: 0,
        attributes,
      };
      state.agentTraceSpans.push(span);
      if (typeof window.performance?.mark === "function") {
        window.performance.mark(
          "terragon.agent_trace." + name + "." + traceId,
          {
            detail: span,
            startTime: Math.max(0, endedAtMs - window.performance.timeOrigin),
          },
        );
      }
      window.dispatchEvent(
        new CustomEvent("terragon:agent-trace", { detail: span }),
      );
    };

    const recordTextMutation = () => {
      const at = relativeNow();
      if (at === null) return;
      const message = lastAgentMessage();
      if (!message) return;
      const previousText = state.previousAgentTextByMessageId[message.id] ?? "";
      if (message.text.length <= previousText.length) return;
      const visibleAtMs = Math.round(at);
      const visibleEpochMs = epochNow();
      const textDeltaBytes = message.text.length - previousText.length;
      const previousVisibleUpdate =
        state.visibleUpdates[state.visibleUpdates.length - 1];
      const gapMs =
        previousVisibleUpdate === undefined
          ? null
          : visibleAtMs - previousVisibleUpdate.visibleAtMs;
      const daemonTrace = consumeDaemonTraceBatchForVisibleUpdate({
        spans: state.agentTraceSpans,
        consumedTraceKeys: state.consumedDaemonTraceKeys,
        visibleEpochMs,
        messageIds:
          message.sourceIds.length > 0 ? message.sourceIds : [message.id],
      });
      const daemonReceivedAtMs = daemonTrace?.oldestReceivedAtMs ?? null;
      const previousTraceBackedUpdate = state.visibleUpdates
        .slice()
        .reverse()
        .find((update) => update.daemonReceivedAtMs !== null);
      let uiOwnedGapMs = null;
      if (daemonReceivedAtMs !== null) {
        if (
          gapMs !== null &&
          previousTraceBackedUpdate?.daemonReceivedAtMs !== undefined &&
          previousTraceBackedUpdate.daemonReceivedAtMs !== null
        ) {
          const daemonCadenceMs = Math.max(
            0,
            daemonReceivedAtMs - previousTraceBackedUpdate.daemonReceivedAtMs,
          );
          uiOwnedGapMs = Math.max(0, gapMs - daemonCadenceMs);
          state.activeStreamGaps.push(uiOwnedGapMs);
          recordBenchmarkTraceSpan("browser.agent_text.chunk_gap", {
            messageId: message.id,
            gapMs,
            uiOwnedGapMs,
            daemonCadenceMs,
          });
        }
        const daemonEventToVisibleUpdateMs = Math.max(
          0,
          Math.round(visibleEpochMs - daemonReceivedAtMs),
        );
        const newestDaemonEventToVisibleUpdateMs = Math.max(
          0,
          Math.round(visibleEpochMs - daemonTrace.newestReceivedAtMs),
        );
        state.daemonEventToVisibleUpdateSamples.push(
          daemonEventToVisibleUpdateMs,
        );
        state.daemonEventToVisibleSamples.push({
          messageId: message.id,
          visibleAtMs,
          visibleEpochMs: Math.round(visibleEpochMs),
          daemonReceivedAtMs,
          newestDaemonReceivedAtMs: daemonTrace.newestReceivedAtMs,
          daemonEventToVisibleUpdateMs,
          newestDaemonEventToVisibleUpdateMs,
          traceKey: daemonTrace.oldestTraceKey,
          traceKeys: daemonTrace.traceKeys,
          consumedTraceCount: daemonTrace.consumedTraceCount,
          textLength: message.text.length,
          textDeltaBytes,
        });
        state.chunkTimes.push(visibleAtMs);
        state.streamedTextBytes += textDeltaBytes;
      }
      state.visibleUpdates.push({
        messageId: message.id,
        sourceIds: message.sourceIds,
        visibleAtMs,
        visibleEpochMs: Math.round(visibleEpochMs),
        textLength: message.text.length,
        textDeltaBytes,
        gapMs,
        uiOwnedGapMs,
        daemonReceivedAtMs,
      });
      state.previousAgentTextByMessageId[message.id] = message.text;
      recordBenchmarkTraceSpan("browser.agent_text.visible", {
        messageId: message.id,
        visibleAtMs,
        textLength: message.text.length,
        textDeltaBytes,
        daemonEventToVisibleUpdateMs:
          daemonReceivedAtMs === null
            ? null
            : Math.max(0, Math.round(visibleEpochMs - daemonReceivedAtMs)),
      });
    };

    const tick = (now) => {
      if (state.startedAtEpochMs !== null && state.lastRafAt !== null) {
        state.rafFrameGaps.push(Math.round(now - state.lastRafAt));
      }
      state.lastRafAt = now;
      state.rafId = window.requestAnimationFrame(tick);
    };

    const scheduleTextMutationSample = () => {
      if (state.pendingTextMutationRafId !== null) {
        return;
      }
      state.pendingTextMutationRafId = window.requestAnimationFrame(() => {
        state.pendingTextMutationRafId = null;
        recordTextMutation();
      });
    };

    const observeTextMutations = () => {
      const mutationRoot = document.body ?? document.documentElement;
      if (!mutationRoot) {
        window.requestAnimationFrame(observeTextMutations);
        return;
      }
      state.observer = new MutationObserver(scheduleTextMutationSample);
      state.observer.observe(mutationRoot, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    };
    observeTextMutations();

    const previousTraceSink = window.__terragonAgentTraceSink;
    window.__terragonAgentTraceSink = (span) => {
      state.agentTraceSpans.push(span);
      if (typeof previousTraceSink === "function") {
        previousTraceSink(span);
      }
    };

    if ("PerformanceObserver" in window) {
      try {
        state.longTaskObserver = new PerformanceObserver((list) => {
          if (state.startedAtEpochMs === null) return;
          for (const entry of list.getEntries()) {
            state.longTasks.push(Math.round(entry.duration));
          }
        });
        state.longTaskObserver.observe({ entryTypes: ["longtask"] });
      } catch {}

      try {
        state.layoutShiftObserver = new PerformanceObserver((list) => {
          if (state.startedAtEpochMs === null) return;
          for (const entry of list.getEntries()) {
            if (entry.hadRecentInput) continue;
            state.layoutShiftEntries.push({
              startTime: entry.startTime,
              value: entry.value ?? 0,
              sources: Array.from(entry.sources ?? [])
                .map((source) => {
                  const node = source.node;
                  if (!(node instanceof Element)) return null;
                  const tag = node.tagName.toLowerCase();
                  const id = node.id ? "#" + node.id : "";
                  const testId = node.getAttribute("data-testid");
                  const role = node.getAttribute("data-message-role");
                  const classes = Array.from(node.classList)
                    .slice(0, 3)
                    .map((className) => "." + className)
                    .join("");
                  return [
                    tag + id + classes,
                    testId ? "data-testid=" + testId : null,
                    role ? "data-message-role=" + role : null,
                  ]
                    .filter(Boolean)
                    .join(" ");
                })
                .filter(Boolean),
            });
          }
        });
        state.layoutShiftObserver.observe({ entryTypes: ["layout-shift"] });
      } catch {}
    }

    state.rafId = window.requestAnimationFrame(tick);

    metricWindow.__terragonStreamMetrics = {
      markSubmit: () => {
        state.startedAtEpochMs = performance.timeOrigin + performance.now();
        window.sessionStorage.setItem(
          submitStartedAtStorageKey,
          String(state.startedAtEpochMs),
        );
        const lastMessage = lastAgentMessage();
        state.previousAgentTextByMessageId = {};
        if (lastMessage) {
          state.previousAgentTextByMessageId[lastMessage.id] =
            lastMessage.text;
        }
        state.chunkTimes = [];
        state.visibleUpdates = [];
        state.activeStreamGaps = [];
        state.daemonEventToVisibleUpdateSamples = [];
        state.daemonEventToVisibleSamples = [];
        state.consumedDaemonTraceKeys = new Set();
        state.agentTraceSpans = [];
        state.streamedTextBytes = 0;
        state.longTasks = [];
        state.rafFrameGaps = [];
        state.layoutShiftEntries = [];
        state.layoutShiftResetAtMs = 0;
        state.lastRafAt = null;
        if (state.pendingTextMutationRafId !== null) {
          window.cancelAnimationFrame(state.pendingTextMutationRafId);
          state.pendingTextMutationRafId = null;
        }
      },
      snapshot: () => {
        const gaps = state.activeStreamGaps;
        const cumulativeLayoutShift = state.layoutShiftEntries.reduce(
          (total, entry) =>
            entry.startTime >= state.layoutShiftResetAtMs
              ? total + entry.value
              : total,
          0,
        );
        return {
          assistantTextChunkCount: state.chunkTimes.length,
          streamedTextBytes: state.streamedTextBytes,
          interChunkGapP50Ms: pickPercentile(gaps, 50),
          interChunkGapP95Ms: pickPercentile(gaps, 95),
          maxSilentGapMs: gaps.length ? Math.max(...gaps) : 0,
          visibleUpdateCount: state.visibleUpdates.length,
          activeStreamGapCount: state.activeStreamGaps.length,
          activeStreamGapP95Ms: pickPercentile(state.activeStreamGaps, 95),
          daemonEventToVisibleUpdateMsP95: pickPercentile(
            state.daemonEventToVisibleUpdateSamples,
            95,
          ),
          longTaskCount: state.longTasks.length,
          maxLongTaskMs: state.longTasks.length ? Math.max(...state.longTasks) : 0,
          totalLongTaskMs: state.longTasks.reduce(
            (total, duration) => total + duration,
            0,
          ),
          rafFrameGapP95Ms: pickPercentile(state.rafFrameGaps, 95),
          cumulativeLayoutShift: Number(cumulativeLayoutShift.toFixed(4)),
          diagnostics: {
            daemonEventToVisibleSamples: state.daemonEventToVisibleSamples,
            visibleUpdates: state.visibleUpdates.slice(-40),
            textTraceSpans: state.agentTraceSpans
              .filter(isTextTraceSpan)
              .slice(-80)
              .map((span) => {
                const traceKey = traceConsumptionKey(span);
                return {
                  traceKey,
                  messageId:
                    typeof span?.attributes?.messageId === "string"
                      ? span.attributes.messageId
                      : null,
                  agUiEventType:
                    typeof span?.attributes?.agUiEventType === "string"
                      ? span.attributes.agUiEventType
                      : null,
                  receivedAtMs: traceReceivedAtMs(span),
                  endedAtMs:
                    typeof span?.endedAtMs === "number" ? span.endedAtMs : null,
                  consumed: state.consumedDaemonTraceKeys.has(traceKey),
                };
              }),
            layoutShiftEntries: state.layoutShiftEntries,
          },
        };
      },
      resetLayoutShift: () => {
        state.layoutShiftResetAtMs = performance.now();
      },
      dispose: () => {
        if (state.observer) state.observer.disconnect();
        if (state.longTaskObserver) state.longTaskObserver.disconnect();
        if (state.layoutShiftObserver) state.layoutShiftObserver.disconnect();
        window.__terragonAgentTraceSink = previousTraceSink;
        if (state.rafId !== null) {
          window.cancelAnimationFrame(state.rafId);
        }
        if (state.pendingTextMutationRafId !== null) {
          window.cancelAnimationFrame(state.pendingTextMutationRafId);
        }
      },
    };
  })()`;
  await page.addInitScript(script);
  await page.evaluate(script);
}

async function resetBrowserLayoutShiftMetric(page: Page): Promise<void> {
  await page.evaluate(() => {
    const metricWindow = window as typeof window & {
      __terragonStreamMetrics?: { resetLayoutShift: () => void };
    };
    metricWindow.__terragonStreamMetrics?.resetLayoutShift();
  });
}

async function markPromptSubmittedForBrowserMetrics(page: Page): Promise<void> {
  await page.evaluate((submitStartedAtStorageKey) => {
    const startedAtEpochMs = performance.timeOrigin + performance.now();
    window.sessionStorage.setItem(
      submitStartedAtStorageKey,
      String(startedAtEpochMs),
    );
    const metricWindow = window as typeof window & {
      __terragonStreamMetrics?: { markSubmit: () => void };
    };
    metricWindow.__terragonStreamMetrics?.markSubmit();
  }, SUBMIT_STARTED_AT_STORAGE_KEY);
}

async function readBrowserStreamMetrics(
  page: Page,
): Promise<BrowserStreamMetricSnapshot> {
  return page.evaluate(() => {
    const metricWindow = window as typeof window & {
      __terragonStreamMetrics?: { snapshot: () => BrowserStreamMetricSnapshot };
    };
    return (
      metricWindow.__terragonStreamMetrics?.snapshot() ?? {
        assistantTextChunkCount: 0,
        streamedTextBytes: 0,
        interChunkGapP50Ms: null,
        interChunkGapP95Ms: null,
        maxSilentGapMs: null,
        visibleUpdateCount: 0,
        activeStreamGapCount: 0,
        activeStreamGapP95Ms: null,
        daemonEventToVisibleUpdateMsP95: null,
        longTaskCount: 0,
        maxLongTaskMs: 0,
        totalLongTaskMs: 0,
        rafFrameGapP95Ms: null,
        cumulativeLayoutShift: 0,
        diagnostics: {
          daemonEventToVisibleSamples: [],
          visibleUpdates: [],
          textTraceSpans: [],
          layoutShiftEntries: [],
        },
      }
    );
  });
}

async function getGitInfo(): Promise<BenchmarkReport["git"]> {
  const [sha, branch, status] = await Promise.all([
    runGit(["rev-parse", "HEAD"], "unknown"),
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], "unknown"),
    runGit(["status", "--porcelain"], ""),
  ]);
  return { sha, branch, dirty: status.length > 0 };
}

async function runGit(args: string[], fallback: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("git", args, { cwd: process.cwd() }, (error, stdout) => {
      resolve(error ? fallback : stdout.trim());
    });
  });
}

async function loginWithDevLogin(page: Page, config: Config): Promise<void> {
  const isHttps = config.appUrl.startsWith("https://");
  if (!isHttps) {
    console.warn(
      "[e2e-prompt] app URL is plain HTTP. Fresh browser contexts may not retain Better Auth's __Secure session cookie; use the HTTPS ngrok URL for full local E2E runs.",
    );
  }

  const response = await page
    .context()
    .request.post(`${config.appUrl}/api/auth/sign-in/dev-login`, {
      data: { returnUrl: "/dashboard" },
    });
  if (!response.ok()) {
    throw new Error(`Dev login failed with HTTP ${response.status()}`);
  }
  const sessionToken = response.headers()["set-auth-token"];
  if (!sessionToken) {
    throw new Error("Dev login response did not include set-auth-token");
  }
  await page.context().addCookies([
    isHttps
      ? {
          name: "__Secure-better-auth.session_token",
          value: sessionToken,
          url: config.appUrl,
          httpOnly: true,
          sameSite: "Lax",
          secure: true,
        }
      : {
          name: "better-auth.session_token",
          value: sessionToken,
          url: config.appUrl,
          httpOnly: true,
          sameSite: "Lax",
          secure: false,
        },
  ]);
  await page.goto(`${config.appUrl}/dashboard`, {
    waitUntil: "domcontentloaded",
    timeout: config.timeoutMs,
  });
  if (page.url().includes("/login")) {
    throw new Error(
      "Dev login did not persist. Use an HTTPS app URL such as https://terragon.ngrok.dev so the __Secure session cookie is accepted.",
    );
  }
}

async function selectRepoAndBranch(page: Page, config: Config): Promise<void> {
  const repoCombobox = page
    .locator('[role="combobox"]')
    .filter({
      hasText: new RegExp(`Select a Repo|${escapeRegExp(config.repo)}`),
    })
    .first();
  await repoCombobox.waitFor({ state: "visible", timeout: 30_000 });

  if (!((await repoCombobox.textContent()) ?? "").includes(config.repo)) {
    await repoCombobox.click();
    await page.getByPlaceholder("Search repositories").fill(config.repo);
    await page
      .locator('[role="option"], [cmdk-item]')
      .filter({ hasText: config.repo })
      .last()
      .click({ timeout: 30_000 });
  }

  const branchCombobox = page
    .locator('[role="combobox"]')
    .filter({
      hasText: new RegExp(`Select a Branch|${escapeRegExp(config.branch)}`),
    })
    .last();
  await branchCombobox.waitFor({ state: "visible", timeout: 30_000 });
  if (((await branchCombobox.textContent()) ?? "").includes(config.branch)) {
    return;
  }
  await branchCombobox.click();
  const branchSearch = page.getByPlaceholder("Search branches");
  try {
    await branchSearch.fill(config.branch, { timeout: 5_000 });
  } catch {
    await page
      .locator('[role="option"], [cmdk-item]')
      .filter({ hasText: config.branch })
      .last()
      .click({ timeout: 10_000 });
    return;
  }
  await page
    .locator('[role="option"], [cmdk-item]')
    .filter({ hasText: config.branch })
    .last()
    .click({ timeout: 30_000 });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function typePrompt(page: Page, prompt: string): Promise<void> {
  const editor = page
    .getByLabel("Describe a task for the AI")
    .locator('[contenteditable="true"]');
  await editor.waitFor({ state: "visible", timeout: 30_000 });
  await editor.click();
  await page.keyboard.insertText(prompt);
  await page
    .locator('button[title="Submit (Enter)"], button[title="Send message"]')
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function getTaskHrefs(page: Page): Promise<string[]> {
  return page
    .locator('a[href^="/task/"]')
    .evaluateAll((links) =>
      links
        .map((link) => link.getAttribute("href"))
        .filter((href): href is string => Boolean(href)),
    );
}

async function getSettledTaskHrefs(page: Page): Promise<string[]> {
  let previous = await getTaskHrefs(page);
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.waitForTimeout(250);
    const next = await getTaskHrefs(page);
    if (
      next.length === previous.length &&
      next.every((href, index) => href === previous[index])
    ) {
      return next;
    }
    previous = next;
  }
  return previous;
}

async function waitForCreatedTaskHref(params: {
  page: Page;
  existingTaskHrefs: string[];
  timeoutMs: number;
}): Promise<string> {
  const { page, existingTaskHrefs, timeoutMs } = params;
  const handle = await page.waitForFunction(
    (knownHrefs) => {
      const known = new Set(knownHrefs);
      const links = [...document.querySelectorAll('a[href^="/task/"]')];
      for (const link of links) {
        const href = link.getAttribute("href");
        if (!href || known.has(href) || href.includes("optimistic")) {
          continue;
        }
        if (link.getAttribute("aria-disabled") === "true") {
          continue;
        }
        return href;
      }
      return null;
    },
    existingTaskHrefs,
    { timeout: timeoutMs },
  );
  const href = await handle.jsonValue();
  if (typeof href !== "string") {
    throw new Error("Created task link did not resolve to a href");
  }
  return href;
}

async function waitForCreatedTaskNavigationOrHref(params: {
  page: Page;
  existingTaskHrefs: string[];
  timeoutMs: number;
}): Promise<string> {
  const { page, existingTaskHrefs, timeoutMs } = params;
  return Promise.any([
    page
      .waitForURL(/\/task\/[^/?#]+/, { timeout: timeoutMs })
      .then(() => new URL(page.url()).pathname),
    waitForCreatedTaskHref({ page, existingTaskHrefs, timeoutMs }),
  ]);
}

async function runIteration(params: {
  browser: Browser;
  config: Config;
  iteration: number;
  warmup: boolean;
}): Promise<RunResult> {
  const { browser, config, iteration, warmup } = params;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const startedAt = performance.now();
  const errors: string[] = [];
  const screenshots: Record<string, string> = {};
  const chunkTimes: number[] = [];
  let routeErrorCount = 0;
  let reconnectCount = 0;
  let firstAssistantTextMs: number | null = null;
  let completionMs: number | null = null;
  let firstToolOutputMs: number | null = null;
  let streamedTextBytes = 0;
  let taskUrl: string | null = null;

  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.includes("/_next/webpack-hmr")) return;
    const failureText = request.failure()?.errorText ?? "";
    if (failureText.includes("ERR_ABORTED")) return;
    errors.push(`requestfailed: ${request.method()} ${url}`);
  });
  page.on("response", (response) => {
    const status = response.status();
    const url = response.url();
    if (status >= 400 && !url.includes("/__nextjs_original-stack-frames")) {
      routeErrorCount++;
      errors.push(`response:${status}: ${url}`);
    }
  });

  try {
    await loginWithDevLogin(page, config);
    await installBrowserStreamMetrics(page);
    await selectRepoAndBranch(page, config);
    await screenshot(page, config, screenshots, iteration, "dashboard-ready");
    await typePrompt(page, config.prompt);
    const existingTaskHrefs = await getSettledTaskHrefs(page);

    const promptSubmittedAtMs = nowMs(startedAt);
    const submitButton = page
      .locator('button[title="Submit (Enter)"], button[title="Send message"]')
      .first();
    await submitButton.waitFor({ state: "visible", timeout: 30_000 });
    await markPromptSubmittedForBrowserMetrics(page);
    await submitButton.click();

    const taskHref = await waitForCreatedTaskNavigationOrHref({
      page,
      existingTaskHrefs,
      timeoutMs: config.timeoutMs,
    });
    const threadCreatedMs = nowMs(startedAt);
    if (!/\/task\/[^/?#]+/.test(page.url())) {
      await page.goto(`${config.appUrl}${taskHref}`, {
        waitUntil: "domcontentloaded",
        timeout: config.timeoutMs,
      });
    }
    await page.waitForURL(/\/task\/[^/?#]+/, { timeout: config.timeoutMs });
    taskUrl = page.url();
    await screenshot(page, config, screenshots, iteration, "task-created");
    await installBrowserStreamMetrics(page);
    await markPromptSubmittedForBrowserMetrics(page);

    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll('[data-message-role="agent"]');
        const last = rows.item(rows.length - 1);
        return (last?.textContent ?? "").trim().length > 0;
      },
      undefined,
      { timeout: config.timeoutMs },
    );
    firstAssistantTextMs = nowMs(startedAt);
    await resetBrowserLayoutShiftMetric(page);

    const observationDeadline = performance.now() + config.timeoutMs;
    let previousBodyText = "";
    while (performance.now() < observationDeadline) {
      const bodyText = await page.locator("body").innerText();
      const assistantText = await page
        .locator('[data-message-role="agent"]')
        .last()
        .textContent()
        .catch(() => "");
      if (bodyText !== previousBodyText) {
        const at = nowMs(startedAt);
        chunkTimes.push(at);
        streamedTextBytes += Math.max(
          0,
          bodyText.length - previousBodyText.length,
        );
        previousBodyText = bodyText;
        if (
          firstToolOutputMs === null &&
          /\/root\/repo|stdout|pwd/i.test(bodyText)
        ) {
          firstToolOutputMs = at;
        }
      }
      if (
        /\bComplete\b|Done|terragon-e2e-benchmark-visible/i.test(
          assistantText ?? "",
        )
      ) {
        completionMs = nowMs(startedAt);
        break;
      }
      if (/reconnect|reconnecting/i.test(bodyText)) {
        reconnectCount++;
      }
      await page.waitForTimeout(1_000);
    }

    await screenshot(page, config, screenshots, iteration, "task-final");

    const totalRunMs = nowMs(startedAt);
    const gaps = chunkTimes
      .slice(1)
      .map((time, index) => time - chunkTimes[index]!);
    const browserMetrics = await readBrowserStreamMetrics(page);
    const metrics: RunMetrics = {
      promptSubmittedAtMs,
      threadCreatedMs,
      sandboxReadyMs: firstToolOutputMs,
      daemonConnectedMs: firstAssistantTextMs,
      firstDaemonEventMs: firstAssistantTextMs,
      firstAssistantTextMs,
      firstToolStartMs: firstToolOutputMs,
      firstToolOutputMs,
      completionMs,
      totalRunMs,
      daemonEventCount: chunkTimes.length,
      assistantTextChunkCount: chunkTimes.length,
      streamedTextBytes,
      interChunkGapP50Ms: percentile(gaps, 50),
      interChunkGapP95Ms: percentile(gaps, 95),
      maxSilentGapMs: gaps.length ? Math.max(...gaps) : 0,
      chunksPerSecond:
        chunkTimes.length > 1 &&
        completionMs !== null &&
        firstAssistantTextMs !== null
          ? chunkTimes.length / ((completionMs - firstAssistantTextMs) / 1000)
          : null,
      routeErrorCount,
      reconnectCount,
      scopedAssistantTextChunkCount: browserMetrics.assistantTextChunkCount,
      scopedStreamedTextBytes: browserMetrics.streamedTextBytes,
      scopedInterChunkGapP50Ms: browserMetrics.interChunkGapP50Ms,
      scopedInterChunkGapP95Ms: browserMetrics.interChunkGapP95Ms,
      scopedMaxSilentGapMs: browserMetrics.maxSilentGapMs,
      visibleUpdateCount: browserMetrics.visibleUpdateCount,
      activeStreamGapCount: browserMetrics.activeStreamGapCount,
      activeStreamGapP95Ms: browserMetrics.activeStreamGapP95Ms,
      daemonEventToVisibleUpdateMsP95:
        browserMetrics.daemonEventToVisibleUpdateMsP95,
      longTaskCount: browserMetrics.longTaskCount,
      maxLongTaskMs: browserMetrics.maxLongTaskMs,
      totalLongTaskMs: browserMetrics.totalLongTaskMs,
      rafFrameGapP95Ms: browserMetrics.rafFrameGapP95Ms,
      cumulativeLayoutShift: browserMetrics.cumulativeLayoutShift,
    };
    const checks = buildChecks(metrics, config.thresholds);
    return {
      iteration,
      warmup,
      status:
        checks.every((check) => check.status === "pass") && errors.length === 0
          ? "pass"
          : "fail",
      taskUrl,
      metrics,
      checks,
      errors,
      screenshots,
      diagnostics: browserMetrics.diagnostics,
    };
  } catch (error) {
    const totalRunMs = nowMs(startedAt);
    errors.push(error instanceof Error ? error.message : String(error));
    await screenshot(page, config, screenshots, iteration, "failure").catch(
      () => {},
    );
    const metrics: RunMetrics = {
      promptSubmittedAtMs: 0,
      threadCreatedMs: null,
      sandboxReadyMs: null,
      daemonConnectedMs: null,
      firstDaemonEventMs: null,
      firstAssistantTextMs,
      firstToolStartMs: null,
      firstToolOutputMs,
      completionMs,
      totalRunMs,
      daemonEventCount: chunkTimes.length,
      assistantTextChunkCount: chunkTimes.length,
      streamedTextBytes,
      interChunkGapP50Ms: null,
      interChunkGapP95Ms: null,
      maxSilentGapMs: null,
      chunksPerSecond: null,
      routeErrorCount,
      reconnectCount,
      scopedAssistantTextChunkCount: 0,
      scopedStreamedTextBytes: 0,
      scopedInterChunkGapP50Ms: null,
      scopedInterChunkGapP95Ms: null,
      scopedMaxSilentGapMs: null,
      visibleUpdateCount: 0,
      activeStreamGapCount: 0,
      activeStreamGapP95Ms: null,
      daemonEventToVisibleUpdateMsP95: null,
      longTaskCount: 0,
      maxLongTaskMs: 0,
      totalLongTaskMs: 0,
      rafFrameGapP95Ms: null,
      cumulativeLayoutShift: 0,
    };
    return {
      iteration,
      warmup,
      status: "fail",
      taskUrl,
      metrics,
      checks: buildChecks(metrics, config.thresholds),
      errors,
      screenshots,
    };
  } finally {
    await context.close();
  }
}

function buildChecks(metrics: RunMetrics, thresholds: Thresholds): Check[] {
  return [
    budgetCheck(
      "thread-created-budget",
      metrics.threadCreatedMs,
      thresholds.threadCreatedMs,
    ),
    budgetCheck(
      "first-assistant-text-budget",
      metrics.firstAssistantTextMs,
      thresholds.firstAssistantTextMs,
    ),
    budgetCheck(
      "completion-budget",
      metrics.completionMs,
      thresholds.completionMs,
    ),
    budgetCheck("total-run-budget", metrics.totalRunMs, thresholds.totalRunMs),
    budgetCheck(
      "stream-silent-gap-budget",
      metrics.maxSilentGapMs,
      thresholds.maxSilentGapMs,
    ),
    budgetCheck(
      "scoped-stream-silent-gap-budget",
      metrics.scopedMaxSilentGapMs,
      thresholds.scopedMaxSilentGapMs,
    ),
    budgetCheck(
      "active-stream-gap-budget",
      metrics.activeStreamGapP95Ms,
      thresholds.activeStreamGapMs,
    ),
    budgetCheck(
      "daemon-event-to-visible-update-budget",
      metrics.daemonEventToVisibleUpdateMsP95,
      thresholds.daemonEventToVisibleUpdateMs,
    ),
    {
      name: "assistant-text-chunk-count",
      status:
        metrics.scopedAssistantTextChunkCount >=
        thresholds.minAssistantTextChunks
          ? "pass"
          : "fail",
      actual: metrics.scopedAssistantTextChunkCount,
      expected: thresholds.minAssistantTextChunks,
    },
    {
      name: "visible-update-count",
      status:
        metrics.visibleUpdateCount >= thresholds.minVisibleUpdates
          ? "pass"
          : "fail",
      actual: metrics.visibleUpdateCount,
      expected: thresholds.minVisibleUpdates,
    },
    budgetCheck(
      "max-long-task-budget",
      metrics.maxLongTaskMs,
      thresholds.maxLongTaskMs,
    ),
    budgetCheck(
      "total-long-task-budget",
      metrics.totalLongTaskMs,
      thresholds.totalLongTaskMs,
    ),
    budgetCheck(
      "raf-frame-gap-p95-budget",
      metrics.rafFrameGapP95Ms,
      thresholds.rafFrameGapP95Ms,
    ),
    {
      name: "streaming-cls-budget",
      status:
        metrics.cumulativeLayoutShift <= thresholds.cumulativeLayoutShift
          ? "pass"
          : "fail",
      actual: metrics.cumulativeLayoutShift,
      limit: thresholds.cumulativeLayoutShift,
    },
    {
      name: "no-route-errors",
      status:
        metrics.routeErrorCount <= thresholds.routeErrorCount ? "pass" : "fail",
      actual: metrics.routeErrorCount,
      limit: thresholds.routeErrorCount,
    },
    {
      name: "assistant-text-rendered",
      status: metrics.firstAssistantTextMs !== null ? "pass" : "fail",
      actual: metrics.firstAssistantTextMs !== null,
      expected: true,
    },
  ];
}

function budgetCheck(
  name: string,
  actual: number | null,
  limit: number,
): Check {
  return {
    name,
    status: actual !== null && actual <= limit ? "pass" : "fail",
    actual: actual ?? "missing",
    limit,
  };
}

async function screenshot(
  page: Page,
  config: Config,
  screenshots: Record<string, string>,
  iteration: number,
  name: string,
): Promise<void> {
  if (!config.screenshotDir) return;
  fs.mkdirSync(config.screenshotDir, { recursive: true });
  const filePath = path.join(
    config.screenshotDir,
    `${String(iteration).padStart(2, "0")}-${name}.png`,
  );
  await page.screenshot({ path: filePath, fullPage: true });
  screenshots[name] = filePath;
}

function summarize(
  config: Config,
  runs: RunResult[],
): BenchmarkReport["summary"] {
  const measuredRuns = runs.filter((run) => !run.warmup);
  const metric = (key: keyof RunMetrics): number[] =>
    measuredRuns
      .map((run) => run.metrics[key])
      .filter((value): value is number => typeof value === "number");
  const metrics = {
    threadCreatedMsP50: percentile(metric("threadCreatedMs"), 50),
    firstAssistantTextMsP50: percentile(metric("firstAssistantTextMs"), 50),
    completionMsP50: percentile(metric("completionMs"), 50),
    interChunkGapP95Ms: percentile(metric("interChunkGapP95Ms"), 95),
    maxSilentGapMsP95: percentile(metric("maxSilentGapMs"), 95),
    scopedAssistantTextChunkCountP50: percentile(
      metric("scopedAssistantTextChunkCount"),
      50,
    ),
    scopedInterChunkGapP95Ms: percentile(
      metric("scopedInterChunkGapP95Ms"),
      95,
    ),
    scopedMaxSilentGapMsP95: percentile(metric("scopedMaxSilentGapMs"), 95),
    visibleUpdateCountP50: percentile(metric("visibleUpdateCount"), 50),
    activeStreamGapMsP95: percentile(metric("activeStreamGapP95Ms"), 95),
    daemonEventToVisibleUpdateMsP95: percentile(
      metric("daemonEventToVisibleUpdateMsP95"),
      95,
    ),
    maxLongTaskMsP95: percentile(metric("maxLongTaskMs"), 95),
    totalLongTaskMsP95: percentile(metric("totalLongTaskMs"), 95),
    rafFrameGapP95Ms: percentile(metric("rafFrameGapP95Ms"), 95),
    cumulativeLayoutShiftP95: percentile(metric("cumulativeLayoutShift"), 95),
    chunksPerSecondP50: percentile(metric("chunksPerSecond"), 50),
    totalRunMsP50: percentile(metric("totalRunMs"), 50),
  };
  const checks: Check[] = [
    budgetCheck(
      "thread-created-budget-p50",
      metrics.threadCreatedMsP50,
      config.thresholds.threadCreatedMs,
    ),
    budgetCheck(
      "first-assistant-text-budget-p50",
      metrics.firstAssistantTextMsP50,
      config.thresholds.firstAssistantTextMs,
    ),
    budgetCheck(
      "completion-budget-p50",
      metrics.completionMsP50,
      config.thresholds.completionMs,
    ),
    budgetCheck(
      "total-run-budget-p50",
      metrics.totalRunMsP50,
      config.thresholds.totalRunMs,
    ),
    budgetCheck(
      "scoped-stream-silent-gap-budget-p95",
      metrics.scopedMaxSilentGapMsP95,
      config.thresholds.scopedMaxSilentGapMs,
    ),
    budgetCheck(
      "active-stream-gap-budget-p95",
      metrics.activeStreamGapMsP95,
      config.thresholds.activeStreamGapMs,
    ),
    budgetCheck(
      "daemon-event-to-visible-update-budget-p95",
      metrics.daemonEventToVisibleUpdateMsP95,
      config.thresholds.daemonEventToVisibleUpdateMs,
    ),
    {
      name: "assistant-text-chunk-count-p50",
      status:
        metrics.scopedAssistantTextChunkCountP50 !== null &&
        metrics.scopedAssistantTextChunkCountP50 >=
          config.thresholds.minAssistantTextChunks
          ? "pass"
          : "fail",
      actual: metrics.scopedAssistantTextChunkCountP50 ?? "missing",
      expected: config.thresholds.minAssistantTextChunks,
    },
    {
      name: "visible-update-count-p50",
      status:
        metrics.visibleUpdateCountP50 !== null &&
        metrics.visibleUpdateCountP50 >= config.thresholds.minVisibleUpdates
          ? "pass"
          : "fail",
      actual: metrics.visibleUpdateCountP50 ?? "missing",
      expected: config.thresholds.minVisibleUpdates,
    },
    budgetCheck(
      "max-long-task-budget-p95",
      metrics.maxLongTaskMsP95,
      config.thresholds.maxLongTaskMs,
    ),
    budgetCheck(
      "total-long-task-budget-p95",
      metrics.totalLongTaskMsP95,
      config.thresholds.totalLongTaskMs,
    ),
    budgetCheck(
      "raf-frame-gap-p95-budget",
      metrics.rafFrameGapP95Ms,
      config.thresholds.rafFrameGapP95Ms,
    ),
    {
      name: "streaming-cls-budget-p95",
      status:
        metrics.cumulativeLayoutShiftP95 !== null &&
        metrics.cumulativeLayoutShiftP95 <=
          config.thresholds.cumulativeLayoutShift
          ? "pass"
          : "fail",
      actual: metrics.cumulativeLayoutShiftP95 ?? "missing",
      limit: config.thresholds.cumulativeLayoutShift,
    },
    {
      name: "all-measured-runs-passed",
      status: measuredRuns.every((run) => run.status === "pass")
        ? "pass"
        : "fail",
      actual: measuredRuns.filter((run) => run.status === "pass").length,
      expected: measuredRuns.length,
    },
  ];
  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    metrics,
    checks,
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendEvents(filePath: string, run: RunResult): void {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(run)}\n`, "utf8");
}

async function main(): Promise<void> {
  if (shouldPrintHelp(process.argv.slice(2))) {
    printHelp();
    return;
  }

  const config = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch({ headless: config.headless });
  const runs: RunResult[] = [];

  try {
    const totalRuns = config.warmup + config.iterations;
    for (let index = 0; index < totalRuns; index++) {
      const run = await runIteration({
        browser,
        config,
        iteration: index + 1,
        warmup: index < config.warmup,
      });
      runs.push(run);
      if (config.eventsOut) appendEvents(config.eventsOut, run);
      console.log(
        `E2E_PROMPT_RUN ${run.iteration} ${run.status} ${JSON.stringify(run.metrics)}`,
      );
    }
  } finally {
    await browser.close();
  }

  const report: BenchmarkReport = {
    schemaVersion: 1,
    kind: "e2e-prompt-startup-streaming-benchmark",
    generatedAt: new Date().toISOString(),
    git: await getGitInfo(),
    target: {
      appUrl: config.appUrl,
      sandboxProvider: process.env.SANDBOX_PROVIDER ?? null,
      transportMode: "browser-dashboard-dev-login",
      promptName: config.promptName,
      repo: config.repo,
      branch: config.branch,
    },
    config: {
      iterations: config.iterations,
      warmup: config.warmup,
      timeoutMs: config.timeoutMs,
      thresholds: config.thresholds,
    },
    summary: summarize(config, runs),
    runs,
  };

  writeJson(config.out, report);
  console.log(`E2E_PROMPT_BENCHMARK ${JSON.stringify(report.summary)}`);
  console.log(`E2E_PROMPT_BENCHMARK_REPORT ${config.out}`);

  if (config.failOnThreshold && report.summary.status === "fail") {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
