import { describe, it, expect } from "vitest";
import { runReducerHarness, printTimingSummary } from "./reducer-harness";
import {
  singleMessageDeltas,
  multiMessageDeltas,
  interleavedToolCalls,
  richPartBurst,
} from "./stress-generator";

describe("streaming stress tests", () => {
  describe("throughput ceiling", () => {
    it.each([
      ["1k deltas", singleMessageDeltas(1_000)],
      ["5k deltas", singleMessageDeltas(5_000)],
      ["10k deltas", singleMessageDeltas(10_000)],
    ])("%s: message count correct", (_name, scenario) => {
      const result = runReducerHarness(scenario.events);
      printTimingSummary(scenario.name, result);

      expect(result.finalMessages).toHaveLength(scenario.expectedMessageCount);
    });

    it.each([
      ["50 messages x 100 deltas", multiMessageDeltas(50, 100)],
      ["100 messages x 50 deltas", multiMessageDeltas(100, 50)],
    ])("%s: multi-message throughput", (_name, scenario) => {
      const result = runReducerHarness(scenario.events);
      printTimingSummary(scenario.name, result);

      expect(result.finalMessages).toHaveLength(scenario.expectedMessageCount);
    });
  });

  describe("jank detection", () => {
    it("1k deltas: P95 < 100us per event", () => {
      const scenario = singleMessageDeltas(1_000);
      const result = runReducerHarness(scenario.events);
      printTimingSummary("jank-1k", result);

      expect(result.p95Us).toBeLessThan(100);
    });

    it("5k deltas: P95 < 200us per event", () => {
      const scenario = singleMessageDeltas(5_000);
      const result = runReducerHarness(scenario.events);
      printTimingSummary("jank-5k", result);

      // Budget relaxes with scale due to string concatenation growth
      expect(result.p95Us).toBeLessThan(200);
    });

    it("10k deltas: no single event > 5ms (after JIT warmup)", () => {
      const scenario = singleMessageDeltas(10_000);
      // Warmup pass: let V8 JIT-compile the reducer hot path
      runReducerHarness(scenario.events);
      // Measured pass
      const result = runReducerHarness(scenario.events);
      printTimingSummary("jank-10k", result);

      expect(result.maxUs).toBeLessThan(5_000);
    });

    it("20 tool calls interleaved: P95 < 200us", () => {
      const scenario = interleavedToolCalls(20, 50);
      const result = runReducerHarness(scenario.events);
      printTimingSummary("jank-tools", result);

      expect(result.p95Us).toBeLessThan(200);
    });

    it("50 rich parts: P95 < 200us", () => {
      const scenario = richPartBurst(50);
      const result = runReducerHarness(scenario.events);
      printTimingSummary("jank-rich", result);

      expect(result.p95Us).toBeLessThan(200);
    });
  });

  describe("throughput floor", () => {
    it("1k deltas: > 50k events/sec", () => {
      const scenario = singleMessageDeltas(1_000);
      const result = runReducerHarness(scenario.events);
      printTimingSummary("throughput-1k", result);

      expect(result.eventsPerSecond).toBeGreaterThan(50_000);
    });

    it("5k deltas: > 30k events/sec", () => {
      const scenario = singleMessageDeltas(5_000);
      const result = runReducerHarness(scenario.events);
      printTimingSummary("throughput-5k", result);

      expect(result.eventsPerSecond).toBeGreaterThan(30_000);
    });

    it("multi-message (50x100): > 30k events/sec", () => {
      const scenario = multiMessageDeltas(50, 100);
      const result = runReducerHarness(scenario.events);
      printTimingSummary("throughput-multi", result);

      expect(result.eventsPerSecond).toBeGreaterThan(30_000);
    });
  });
});
