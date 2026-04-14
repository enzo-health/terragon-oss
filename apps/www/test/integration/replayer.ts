/**
 * Replayer — drives the real Next.js daemon-event POST handler in-process
 * from a .jsonl recording file.
 *
 * Usage (from tests):
 *   import { replay } from "./replayer";
 *   const results = await replay("./recordings/foo.jsonl", { mode: "fast-forward" });
 *
 * The replayer uses the test-auth bypass header (`X-Terragon-Test-Daemon-Auth`),
 * which the route accepts in non-production environments, so no real daemon token
 * is required.
 */

import * as fs from "fs";
import * as path from "path";
import type { RecordedDaemonEvent } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReplayMode = "fast-forward" | "realtime";

export type ReplayOptions = {
  /**
   * "fast-forward" (default): ignores wallClockMs delays, replays as fast as
   * possible — suitable for CI.
   * "realtime": honours wallClockMs deltas via setTimeout — useful for
   * debugging / visual inspection only.
   */
  mode?: ReplayMode;
  /**
   * Internal shared secret used to activate the test-auth bypass on the route.
   * Defaults to "123456" (the dev/test default).
   */
  internalSecret?: string;
  /**
   * User ID to inject into the request context via test-auth.
   * Defaults to "test-user-replay".
   */
  userId?: string;
};

export type ReplayEventResult = {
  wallClockMs: number;
  body: RecordedDaemonEvent["body"];
  status: number;
  responseBody: unknown;
};

// ---------------------------------------------------------------------------
// JSONL loading
// ---------------------------------------------------------------------------

export function loadRecording(recordingPath: string): RecordedDaemonEvent[] {
  const raw = fs.readFileSync(path.resolve(recordingPath), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedDaemonEvent);
}

// ---------------------------------------------------------------------------
// Core replay function
// ---------------------------------------------------------------------------

/**
 * Replays a .jsonl recording against the real Next.js daemon-event route
 * handler (imported in-process). Returns the response status + body for each
 * event, in order.
 */
export async function replay(
  recordingPathOrEvents: string | RecordedDaemonEvent[],
  options: ReplayOptions = {},
): Promise<ReplayEventResult[]> {
  const events =
    typeof recordingPathOrEvents === "string"
      ? loadRecording(recordingPathOrEvents)
      : recordingPathOrEvents;

  const {
    mode = "fast-forward",
    internalSecret = "123456",
    userId = "test-user-replay",
  } = options;

  // Lazy-import the route handler so this module can be imported in unit tests
  // that only test the replayer shape without a full Next.js environment.
  // In tests that call replay(), the normal vite.config.ts mocks will be active.
  const { POST } = await import("../../src/app/api/daemon-event/route");

  const results: ReplayEventResult[] = [];

  // Track wall-clock progress for realtime mode
  let prevWallClockMs = events[0]?.wallClockMs ?? 0;

  for (const event of events) {
    if (mode === "realtime" && results.length > 0) {
      const delay = event.wallClockMs - prevWallClockMs;
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
    prevWallClockMs = event.wallClockMs;

    // Auto-inject the daemon-capability header for v2 envelopes so the route
    // doesn't reject with "daemon_event_v2_envelope_requires_capability_v2".
    const isV2Envelope =
      event.body.payloadVersion === 2 &&
      typeof event.body.eventId === "string" &&
      event.body.eventId.length > 0 &&
      typeof event.body.runId === "string" &&
      event.body.runId.length > 0 &&
      typeof event.body.seq === "number";

    // Merge the recorded headers with the test-auth bypass headers.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(isV2Envelope
        ? { "x-daemon-capabilities": "daemon_event_envelope_v2" }
        : {}),
      ...event.headers,
      // Test-auth bypass — accepted by the route in non-production
      "x-terragon-test-daemon-auth": "enabled",
      "x-terragon-secret": internalSecret,
      "x-terragon-test-user-id": userId,
    };

    const request = new Request("http://localhost/api/daemon-event", {
      method: "POST",
      headers,
      body: JSON.stringify(event.body),
    });

    const response: Response = await POST(request);

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = null;
    }

    results.push({
      wallClockMs: event.wallClockMs,
      body: event.body,
      status: response.status,
      responseBody,
    });
  }

  return results;
}
