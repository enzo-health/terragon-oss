/**
 * Unit tests for `buildInstallProgressReporter` in setup.ts.
 *
 * Uses vi.useFakeTimers() so there are no real wall-clock waits.
 * The throttle window is 200 ms (INSTALL_PROGRESS_THROTTLE_MS).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildInstallProgressReporter } from "./setup";
import type { InstallProgressSnapshot } from "./install-progress-parser";

// Mock daemon so the module can be imported without side-effects.
vi.mock("./daemon", () => ({
  installDaemon: vi.fn().mockResolvedValue(undefined),
  updateDaemonIfOutdated: vi.fn().mockResolvedValue(undefined),
  restartDaemonIfNotRunning: vi.fn().mockResolvedValue(undefined),
  MCP_SERVER_FILE_PATH: "/tmp/terry-mcp-server.mjs",
}));

// A progress line that the real parser will recognise.
const PROGRESS_LINE = "Progress: resolved 10, reused 5, downloaded 3, added 2";

describe("buildInstallProgressReporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flush() emits if lines were parsed", () => {
    const startMs = Date.now();
    const calls: Array<[InstallProgressSnapshot, number]> = [];
    const reporter = buildInstallProgressReporter(startMs, (snap, elapsed) => {
      calls.push([snap, elapsed]);
    });

    // Advance into the throttle window so the inline throttle does NOT fire,
    // then call processLine.  We need to manufacture a situation where
    // processLine sees now - lastEmitMs < 200 so it skips the inline emit.
    // We achieve this by:
    //   1. Firing a first line (emits, sets lastEmitMs = now).
    //   2. Advancing by < 200 ms.
    //   3. Firing a second line (throttled, no emit).
    //   4. Calling flush — must emit the second snapshot.
    reporter.processLine(PROGRESS_LINE); // first emit (lastEmitMs set)
    vi.advanceTimersByTime(50); // still within throttle window
    reporter.processLine(
      "Progress: resolved 20, reused 10, downloaded 8, added 5",
    ); // throttled, no emit yet
    reporter.flush(); // must emit the latest accumulated state

    // Two emits total: one from processLine, one from flush.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const lastSnap = calls[calls.length - 1]![0];
    expect(lastSnap.resolved).toBe(20);
  });

  it("flush() does not emit if no lines were parsed", () => {
    const startMs = Date.now();
    const calls: Array<[InstallProgressSnapshot, number]> = [];
    const reporter = buildInstallProgressReporter(startMs, (snap, elapsed) => {
      calls.push([snap, elapsed]);
    });

    reporter.processLine("this line has no pnpm progress info");
    reporter.flush();

    expect(calls).toHaveLength(0);
  });

  it("rapid calls within 200 ms emit only once (throttle)", () => {
    const startMs = Date.now();
    const calls: Array<[InstallProgressSnapshot, number]> = [];
    const reporter = buildInstallProgressReporter(startMs, (snap, elapsed) => {
      calls.push([snap, elapsed]);
    });

    // First processLine fires immediately (lastEmitMs starts at 0 and
    // Date.now() is a large epoch value, so now - 0 >= 200 is always true).
    reporter.processLine(PROGRESS_LINE);
    expect(calls).toHaveLength(1); // confirmed first emit

    // Advance by 50 ms — still within the 200 ms throttle window from the
    // first emit.  A second parseable line must NOT trigger another emit.
    vi.advanceTimersByTime(50);
    reporter.processLine(
      "Progress: resolved 20, reused 10, downloaded 8, added 5",
    );

    expect(calls).toHaveLength(1); // still only one emit
  });

  it("call after 200 ms gap emits again", () => {
    const startMs = Date.now();
    const calls: Array<[InstallProgressSnapshot, number]> = [];
    const reporter = buildInstallProgressReporter(startMs, (snap, elapsed) => {
      calls.push([snap, elapsed]);
    });

    reporter.processLine(PROGRESS_LINE); // first emit
    expect(calls).toHaveLength(1);

    // Advance past the throttle window.
    vi.advanceTimersByTime(200);
    reporter.processLine(
      "Progress: resolved 50, reused 20, downloaded 25, added 5",
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]![0].resolved).toBe(50);
  });

  it("final flush after install completes does not drop last snapshot", () => {
    const startMs = Date.now();
    const calls: Array<[InstallProgressSnapshot, number]> = [];
    const reporter = buildInstallProgressReporter(startMs, (snap, elapsed) => {
      calls.push([snap, elapsed]);
    });

    // First progress update — emits immediately.
    reporter.processLine(PROGRESS_LINE);
    expect(calls).toHaveLength(1);

    // A final progress line arrives within the throttle window.
    vi.advanceTimersByTime(50);
    reporter.processLine(
      "Progress: resolved 100, reused 40, downloaded 50, added 10",
    );
    // Still within throttle — not yet emitted.
    expect(calls).toHaveLength(1);

    // Install completes — flush must emit the final accumulated state.
    reporter.flush();

    expect(calls).toHaveLength(2);
    const finalSnap = calls[1]![0];
    expect(finalSnap.resolved).toBe(100);
    expect(finalSnap.added).toBe(10);
  });
});
