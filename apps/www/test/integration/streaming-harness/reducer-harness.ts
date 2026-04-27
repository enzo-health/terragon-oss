import {
  createInitialThreadViewModelState,
  projectThreadViewModel,
  threadViewModelReducer,
} from "@/components/chat/thread-view-model/reducer";
import { createEmptyThreadViewSnapshot } from "@/components/chat/thread-view-model/legacy-db-message-adapter";
import type { ThreadViewModelState } from "@/components/chat/thread-view-model/types";
import type { BaseEvent } from "@ag-ui/core";
import type { AIAgent } from "@terragon/agent/types";
import type { UIMessage } from "@terragon/shared";

export type ReducerTimingEntry = {
  eventIndex: number;
  eventType: string;
  durationUs: number;
  messageCount: number;
};

export type ReducerHarnessResult = {
  finalMessages: UIMessage[];
  finalState: ThreadViewModelState;
  timing: ReducerTimingEntry[];
  totalDurationMs: number;
  p50Us: number;
  p95Us: number;
  p99Us: number;
  maxUs: number;
  eventsPerSecond: number;
};

export function runReducerHarness(
  events: BaseEvent[],
  opts?: { agent?: AIAgent; initialMessages?: UIMessage[] },
): ReducerHarnessResult {
  const agent: AIAgent = opts?.agent ?? "claudeCode";
  const initialMessages = opts?.initialMessages ?? [];

  let state = createInitialThreadViewModelState(
    createEmptyThreadViewSnapshot({ agent, initialMessages }),
  );
  const timing: ReducerTimingEntry[] = [];

  const wallStart = performance.now();

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const t0 = performance.now();
    state = threadViewModelReducer(state, { type: "ag-ui.event", event });
    const t1 = performance.now();

    timing.push({
      eventIndex: i,
      eventType: String(event.type),
      durationUs: (t1 - t0) * 1000,
      messageCount: projectThreadViewModel(state).messages.length,
    });
  }

  const wallEnd = performance.now();
  const totalDurationMs = wallEnd - wallStart;

  const durations = timing.map((t) => t.durationUs).sort((a, b) => a - b);

  return {
    finalMessages: projectThreadViewModel(state).messages,
    finalState: state,
    timing,
    totalDurationMs,
    p50Us: percentile(durations, 50),
    p95Us: percentile(durations, 95),
    p99Us: percentile(durations, 99),
    maxUs: durations.length > 0 ? durations[durations.length - 1]! : 0,
    eventsPerSecond:
      totalDurationMs > 0 ? (events.length / totalDurationMs) * 1000 : 0,
  };
}

export function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

export function printTimingSummary(
  label: string,
  result: ReducerHarnessResult,
): void {
  console.log(
    `[${label}] ${result.timing.length} events in ${result.totalDurationMs.toFixed(1)}ms | ` +
      `P50=${result.p50Us.toFixed(0)}us P95=${result.p95Us.toFixed(0)}us ` +
      `P99=${result.p99Us.toFixed(0)}us Max=${result.maxUs.toFixed(0)}us | ` +
      `${Math.round(result.eventsPerSecond).toLocaleString()} events/sec`,
  );
}
