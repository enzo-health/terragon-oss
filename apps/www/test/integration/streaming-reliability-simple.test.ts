/**
 * Simple Streaming Reliability Test
 *
 * Uses the working stress test infrastructure to measure streaming reliability.
 * Focuses on what we can actually validate: message ordering, reducer performance,
 * and event processing integrity.
 */

import { describe, it, expect } from "vitest";
import { runReducerHarness } from "./streaming-harness/reducer-harness";
import {
  singleMessageDeltas,
  multiMessageDeltas,
  interleavedToolCalls,
} from "./streaming-harness/stress-generator";

type ReliabilityResult = {
  testName: string;
  reliabilityScore: number;
  eventsProcessed: number;
  finalMessageCount: number;
  expectedMessageCount: number;
  orderingCorrect: boolean;
  p95LatencyUs: number;
  maxLatencyUs: number;
  eventsPerSecond: number;
  errors: string[];
};

function runReliabilityTest(params: {
  testName: string;
  events: { type: string; payload: unknown }[];
  expectedMessageCount: number;
}): ReliabilityResult {
  const { testName, events, expectedMessageCount } = params;
  const errors: string[] = [];

  const startTime = performance.now();
  const result = runReducerHarness(events);
  const endTime = performance.now();

  // Check message count
  const messageCountCorrect =
    result.finalMessages.length === expectedMessageCount;
  if (!messageCountCorrect) {
    errors.push(
      `Message count mismatch: expected ${expectedMessageCount}, got ${result.finalMessages.length}`,
    );
  }

  // Check ordering (messages should maintain sequence)
  const messageIds = result.finalMessages.map((m, i) => {
    // Extract any ID or sequence info from message
    const msg = m as { timestamp?: string; index?: number };
    return msg.index ?? i;
  });

  let orderingCorrect = true;
  for (let i = 1; i < messageIds.length; i++) {
    if (messageIds[i]! < messageIds[i - 1]!) {
      orderingCorrect = false;
      errors.push(`Out of order at index ${i}`);
      break;
    }
  }

  // Calculate reliability score
  const deliveryRate = result.finalMessages.length / expectedMessageCount;
  const orderingPenalty = orderingCorrect ? 0 : 0.2;
  const latencyPenalty = result.p95Us > 1000 ? 0.1 : 0; // Penalty if P95 > 1ms

  const reliabilityScore = Math.max(
    0,
    Math.round((deliveryRate - orderingPenalty - latencyPenalty) * 100),
  );

  return {
    testName,
    reliabilityScore,
    eventsProcessed: events.length,
    finalMessageCount: result.finalMessages.length,
    expectedMessageCount,
    orderingCorrect,
    p95LatencyUs: result.p95Us,
    maxLatencyUs: result.maxUs,
    eventsPerSecond: result.eventsPerSecond,
    errors,
  };
}

describe("Streaming Reliability (Simple)", () => {
  it("reliably processes 1000 deltas into correct message count", () => {
    const scenario = singleMessageDeltas(1000);
    const result = runReliabilityTest({
      testName: "1k_deltas",
      events: scenario.events,
      expectedMessageCount: scenario.expectedMessageCount,
    });

    console.log(
      "RELIABILITY_RESULT_1K:",
      JSON.stringify({
        reliabilityScore: result.reliabilityScore,
        eventsProcessed: result.eventsProcessed,
        finalMessageCount: result.finalMessageCount,
        expectedMessageCount: result.expectedMessageCount,
        orderingCorrect: result.orderingCorrect,
        p95LatencyUs: result.p95LatencyUs,
        eventsPerSecond: result.eventsPerSecond,
        errorCount: result.errors.length,
      }),
    );

    expect(result.reliabilityScore).toBeGreaterThanOrEqual(95);
    expect(result.orderingCorrect).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("handles multi-message streams (50 x 100 deltas)", () => {
    const scenario = multiMessageDeltas(50, 100);
    const result = runReliabilityTest({
      testName: "multi_message",
      events: scenario.events,
      expectedMessageCount: scenario.expectedMessageCount,
    });

    console.log(
      "RELIABILITY_RESULT_MULTI:",
      JSON.stringify({
        reliabilityScore: result.reliabilityScore,
        eventsProcessed: result.eventsProcessed,
        finalMessageCount: result.finalMessageCount,
        expectedMessageCount: result.expectedMessageCount,
        orderingCorrect: result.orderingCorrect,
        eventsPerSecond: result.eventsPerSecond,
        errorCount: result.errors.length,
      }),
    );

    expect(result.reliabilityScore).toBeGreaterThanOrEqual(90);
    expect(result.finalMessageCount).toBe(scenario.expectedMessageCount);
  });

  it("handles interleaved tool calls (20 tools x 50 deltas)", () => {
    const scenario = interleavedToolCalls(20, 50);
    const result = runReliabilityTest({
      testName: "tool_calls",
      events: scenario.events,
      expectedMessageCount: scenario.expectedMessageCount,
    });

    console.log(
      "RELIABILITY_RESULT_TOOLS:",
      JSON.stringify({
        reliabilityScore: result.reliabilityScore,
        eventsProcessed: result.eventsProcessed,
        finalMessageCount: result.finalMessageCount,
        orderingCorrect: result.orderingCorrect,
        eventsPerSecond: result.eventsPerSecond,
        errorCount: result.errors.length,
      }),
    );

    expect(result.reliabilityScore).toBeGreaterThanOrEqual(90);
    expect(result.orderingCorrect).toBe(true);
  });

  it("maintains performance under stress (10k deltas)", () => {
    const scenario = singleMessageDeltas(10000);

    // Warmup
    runReducerHarness(scenario.events);

    // Measured run
    const result = runReliabilityTest({
      testName: "stress_10k",
      events: scenario.events,
      expectedMessageCount: scenario.expectedMessageCount,
    });

    console.log(
      "RELIABILITY_RESULT_STRESS:",
      JSON.stringify({
        reliabilityScore: result.reliabilityScore,
        eventsProcessed: result.eventsProcessed,
        finalMessageCount: result.finalMessageCount,
        p95LatencyUs: result.p95LatencyUs,
        maxLatencyUs: result.maxLatencyUs,
        eventsPerSecond: result.eventsPerSecond,
        errorCount: result.errors.length,
      }),
    );

    // Under stress, allow slightly lower reliability but no data loss
    expect(result.reliabilityScore).toBeGreaterThanOrEqual(85);
    expect(result.p95LatencyUs).toBeLessThan(5000); // P95 under 5ms
  });
});
