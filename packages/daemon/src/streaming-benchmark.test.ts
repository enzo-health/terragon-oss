/**
 * Streaming Performance Benchmark
 *
 * Measures the daemon's message buffering and flush performance.
 * These are micro-benchmarks of the core streaming logic.
 */

import { describe, expect, it, vi } from "vitest";
import { TerragonDaemon } from "./daemon";
import { DaemonRuntime } from "./runtime";
import { DaemonEventAPIBody, ClaudeMessage } from "./shared";

interface BenchmarkResult {
  medianLatencyMs: number;
  p99LatencyMs: number;
  messagesPerSecond: number;
  flushCount: number;
  totalDurationMs: number;
  messagesPerFlush: number;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculatePercentile(sorted: number[], percentile: number): number {
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

/**
 * Run a streaming benchmark with configurable parameters
 */
async function runStreamingBenchmark(params: {
  messageFlushDelay: number;
  messageCount: number;
  interMessageDelayMs: number;
}): Promise<BenchmarkResult> {
  const { messageFlushDelay, messageCount, interMessageDelayMs } = params;

  const flushTimestamps: number[] = [];
  const messageGenTimestamps: number[] = [];
  const flushCountsAtMessage: number[] = [];

  // Create mock runtime that captures timing
  const serverPostMock = vi.fn(
    async (_payload: DaemonEventAPIBody, _token: string) => {
      flushTimestamps.push(Date.now());
      await sleep(5); // Simulate API latency
      return null;
    },
  );

  const runtime = {
    url: "http://localhost:3000",
    unixSocketPath: "/tmp/test.sock",
    normalizedUrl: "http://localhost:3000",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    serverPost: serverPostMock,
    listenToUnixSocket: vi.fn(),
    onTeardown: vi.fn(),
    spawnCommandLine: vi.fn(),
    killChildProcessGroup: vi.fn(),
    execSync: vi.fn().mockReturnValue("mock-sha-1234567890abcdef"),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    exitProcess: vi.fn(),
  } as unknown as DaemonRuntime;

  // Create daemon with configurable flush delay
  const daemon = new TerragonDaemon({
    runtime,
    messageFlushDelay,
    messageHandleDelay: 0,
    uptimeReportingInterval: 60000,
  });

  const threadChatId = `test-thread-chat-${Date.now()}`;
  const threadId = `test-thread-${Date.now()}`;
  const token = "test-token";

  const startTime = Date.now();

  // Generate messages and add them to daemon buffer
  for (let i = 0; i < messageCount; i++) {
    const msg: ClaudeMessage = {
      type: "assistant",
      session_id: "test-session",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Benchmark message ${i}` }],
      },
    };

    messageGenTimestamps.push(Date.now());
    flushCountsAtMessage.push(flushTimestamps.length);

    // Access internal method via type assertion
    (daemon as any).addMessageToBuffer({
      agent: "claudeCode",
      message: msg,
      threadId,
      threadChatId,
      token,
    });

    if (interMessageDelayMs > 0) {
      await sleep(interMessageDelayMs);
    }
  }

  // Wait for final flush with multiple attempts
  const maxWaitTime = messageFlushDelay * 5 + 200;
  const checkInterval = 20;
  let waited = 0;

  while (waited < maxWaitTime) {
    await sleep(checkInterval);
    waited += checkInterval;

    // Trigger flush check by adding a no-op message
    if (waited % 50 === 0) {
      (daemon as any).flushMessageBuffer?.();
    }

    // Stop waiting if we've seen all expected flushes
    if (
      flushTimestamps.length > 0 &&
      flushTimestamps.length >= Math.ceil(messageCount / 10)
    ) {
      break;
    }
  }

  // Force one more flush attempt
  await sleep(messageFlushDelay + 20);
  (daemon as any).flushMessageBuffer?.();
  await sleep(30);

  const endTime = Date.now();
  const totalDuration = endTime - startTime;

  // Calculate metrics
  if (flushTimestamps.length === 0) {
    return {
      medianLatencyMs: 0,
      p99LatencyMs: 0,
      messagesPerSecond: 0,
      flushCount: 0,
      totalDurationMs: totalDuration,
      messagesPerFlush: 0,
    };
  }

  // Calculate latency from message generation to flush
  const latencies = messageGenTimestamps.map((genTime, i) => {
    const flushIndex = flushCountsAtMessage[i] ?? 0;
    const flushTime =
      flushTimestamps[flushIndex] ??
      flushTimestamps[flushTimestamps.length - 1] ??
      genTime;
    return Math.max(0, flushTime - genTime);
  });

  const sortedLatencies = [...latencies].sort((a, b) => a - b);

  return {
    medianLatencyMs: calculatePercentile(sortedLatencies, 50),
    p99LatencyMs: calculatePercentile(sortedLatencies, 99),
    messagesPerSecond: (messageCount / totalDuration) * 1000,
    flushCount: flushTimestamps.length,
    totalDurationMs: totalDuration,
    messagesPerFlush: messageCount / flushTimestamps.length,
  };
}

describe("streaming performance benchmark", () => {
  it("baseline: 33ms flush delay (current default)", async () => {
    const result = await runStreamingBenchmark({
      messageFlushDelay: 33,
      messageCount: 30,
      interMessageDelayMs: 10,
    });

    console.log(
      "BASELINE_RESULT_33MS:",
      JSON.stringify({
        flushDelay: 33,
        medianLatencyMs: result.medianLatencyMs,
        p99LatencyMs: result.p99LatencyMs,
        messagesPerSecond: result.messagesPerSecond,
        flushCount: result.flushCount,
        messagesPerFlush: result.messagesPerFlush,
      }),
    );

    // Document baseline - don't hard fail on metrics
    expect(result.flushCount).toBeGreaterThanOrEqual(0);
  }, 10000);

  it("compare: 16ms flush delay (60fps)", async () => {
    const result = await runStreamingBenchmark({
      messageFlushDelay: 16,
      messageCount: 30,
      interMessageDelayMs: 10,
    });

    console.log(
      "COMPARE_RESULT_16MS:",
      JSON.stringify({
        flushDelay: 16,
        medianLatencyMs: result.medianLatencyMs,
        p99LatencyMs: result.p99LatencyMs,
        messagesPerSecond: result.messagesPerSecond,
        flushCount: result.flushCount,
        messagesPerFlush: result.messagesPerFlush,
      }),
    );

    expect(result.flushCount).toBeGreaterThanOrEqual(0);
  }, 10000);

  it("compare: 50ms flush delay", async () => {
    const result = await runStreamingBenchmark({
      messageFlushDelay: 50,
      messageCount: 30,
      interMessageDelayMs: 10,
    });

    console.log(
      "COMPARE_RESULT_50MS:",
      JSON.stringify({
        flushDelay: 50,
        medianLatencyMs: result.medianLatencyMs,
        p99LatencyMs: result.p99LatencyMs,
        messagesPerSecond: result.messagesPerSecond,
        flushCount: result.flushCount,
        messagesPerFlush: result.messagesPerFlush,
      }),
    );

    expect(result.flushCount).toBeGreaterThanOrEqual(0);
  }, 10000);

  it("compare: 8ms flush delay (aggressive)", async () => {
    const result = await runStreamingBenchmark({
      messageFlushDelay: 8,
      messageCount: 30,
      interMessageDelayMs: 10,
    });

    console.log(
      "COMPARE_RESULT_8MS:",
      JSON.stringify({
        flushDelay: 8,
        medianLatencyMs: result.medianLatencyMs,
        p99LatencyMs: result.p99LatencyMs,
        messagesPerSecond: result.messagesPerSecond,
        flushCount: result.flushCount,
        messagesPerFlush: result.messagesPerFlush,
      }),
    );

    expect(result.flushCount).toBeGreaterThanOrEqual(0);
  }, 10000);

  it("stress: rapid message burst", async () => {
    const result = await runStreamingBenchmark({
      messageFlushDelay: 33,
      messageCount: 50,
      interMessageDelayMs: 2, // Very rapid
    });

    console.log(
      "STRESS_RESULT_RAPID:",
      JSON.stringify({
        medianLatencyMs: result.medianLatencyMs,
        p99LatencyMs: result.p99LatencyMs,
        messagesPerSecond: result.messagesPerSecond,
        flushCount: result.flushCount,
        messagesPerFlush: result.messagesPerFlush,
      }),
    );

    expect(result.flushCount).toBeGreaterThanOrEqual(0);
  }, 15000);
});

describe("streaming optimization experiments", () => {
  it("measure delta flush timing", async () => {
    const flushTimestamps: number[] = [];

    const runtime = {
      url: "http://localhost:3000",
      unixSocketPath: "/tmp/test.sock",
      normalizedUrl: "http://localhost:3000",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      serverPost: vi.fn(async () => {
        flushTimestamps.push(Date.now());
        return null;
      }),
      listenToUnixSocket: vi.fn(),
      onTeardown: vi.fn(),
      spawnCommandLine: vi.fn(),
      killChildProcessGroup: vi.fn(),
      execSync: vi.fn(),
      readFileSync: vi.fn().mockReturnValue("{}"),
      writeFileSync: vi.fn(),
      exitProcess: vi.fn(),
    } as unknown as DaemonRuntime;

    const daemon = new TerragonDaemon({
      runtime,
      messageFlushDelay: 33,
      messageHandleDelay: 0,
    });

    const threadChatId = `delta-test-${Date.now()}`;
    const startTime = Date.now();

    // Enqueue 20 deltas rapidly
    for (let i = 0; i < 20; i++) {
      (daemon as any).enqueueDelta({
        threadId: "test-thread",
        threadChatId,
        token: "test-token",
        messageId: `msg-${i}`,
        partIndex: 0,
        kind: "text",
        text: `Delta ${i}`,
      });
    }

    // Wait for delta flush (should use 16ms timer)
    await sleep(100);

    const duration = Date.now() - startTime;

    console.log(
      "DELTA_FLUSH_RESULT:",
      JSON.stringify({
        deltaCount: 20,
        flushCount: flushTimestamps.length,
        totalDurationMs: duration,
      }),
    );

    expect(duration).toBeGreaterThanOrEqual(0);
  }, 5000);
});
